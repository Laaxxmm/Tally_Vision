/**
 * TallyVision - Chunked Data Extraction Engine
 * Pulls data from Tally month-by-month into SQLite
 * Solves the 1MB limit problem by bypassing LLM entirely
 */

const { TallyConnector } = require('../tally-connector');
const { TEMPLATES } = require('./xml-templates');
const { XMLParser } = require('fast-xml-parser');

class DataExtractor {
    constructor(db, config = {}) {
        this.db = db;
        this.tally = new TallyConnector({
            host: config.host || 'localhost',
            port: config.port || 9000,
            timeout: config.timeout || 300000   // 5 min — large XML responses from Tally
        });
        this.xmlParser = new XMLParser({
            parseTagValue: false,
            isArray: (tagName) => tagName === 'ROW' || tagName.endsWith('.LIST')
        });
        this.onProgress = config.onProgress || (() => {});
        this.maxRetries = 3;
    }

    generateMonthChunks(fromDate, toDate) {
        const chunks = [];
        let current = new Date(fromDate + 'T00:00:00');
        const end = new Date(toDate + 'T00:00:00');
        while (current <= end) {
            const monthStart = new Date(current.getFullYear(), current.getMonth(), 1);
            const monthEnd = new Date(current.getFullYear(), current.getMonth() + 1, 0);
            const from = this.formatDate(monthStart < new Date(fromDate) ? new Date(fromDate) : monthStart);
            const to = this.formatDate(monthEnd > end ? end : monthEnd);
            chunks.push({
                from, to,
                label: `${monthStart.toLocaleString('en', { month: 'short' })} ${monthStart.getFullYear()}`
            });
            current = new Date(current.getFullYear(), current.getMonth() + 1, 1);
        }
        return chunks;
    }

    // Quarter-level chunks: Apr-Jun, Jul-Sep, Oct-Dec, Jan-Mar
    // 4 requests/year vs 12 — safe for trial_balance and stock_summary
    generateQuarterChunks(fromDate, toDate) {
        const chunks = [];
        let current = new Date(fromDate + 'T00:00:00');
        const end = new Date(toDate + 'T00:00:00');
        // Quarter end months (0-indexed): Jun=5, Sep=8, Dec=11, Mar=2
        const qEnd = [2, 5, 8, 11];
        while (current <= end) {
            const y = current.getFullYear();
            const m = current.getMonth(); // 0-indexed
            const qEndMonth = qEnd.find(e => e >= m) ?? 2; // next quarter-end month
            const qEndYear = qEndMonth === 2 && m > 2 ? y + 1 : y;
            const quarterEnd = new Date(qEndYear, qEndMonth + 1, 0); // last day of qEndMonth
            const from = this.formatDate(current);
            const to = this.formatDate(quarterEnd > end ? end : quarterEnd);
            const label = `Q${Math.floor([3,3,3,0,0,0,1,1,1,2,2,2][m])+1} ${y}`.replace(
                /Q(\d) (\d+)/, (_, q, yr) => `Q${[0,1,2,3].indexOf(+q-1) === -1 ? q : q} ${yr}`
            );
            chunks.push({ from, to, label: `${current.toLocaleString('en',{month:'short'})}-${quarterEnd.toLocaleString('en',{month:'short'})} ${qEndYear}` });
            current = new Date(qEndYear, qEndMonth + 1, 1); // first day after quarter end
        }
        return chunks;
    }

    // Returns true if the period's end date is before the start of the current month
    isHistoricalPeriod(toDate) {
        const startOfMonth = new Date().toISOString().substring(0, 8) + '01';
        return toDate < startOfMonth;
    }

    formatDate(d) {
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }

    formatTallyDate(d) {
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const date = new Date(d + 'T00:00:00');
        return `${date.getDate()}-${months[date.getMonth()]}-${date.getFullYear()}`;
    }

    parseNumber(val) {
        if (!val) return 0;
        const s = String(val).trim();
        // Tally uses (1234.56) to denote negative — detect before stripping
        const isNegative = /^\(.*\)$/.test(s);
        const clean = parseFloat(s.replace(/[\(\),\s]+/g, '')) || 0;
        return isNegative ? -Math.abs(clean) : clean;
    }

    parseDate(val) {
        if (!val) return null;
        const s = String(val);
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
        const months = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
        const m = s.match(/^(\d{1,2})-(\w{3})-(\d{2,4})$/i);
        if (m) {
            const day = m[1].padStart(2,'0');
            const mon = String(months[m[2].toLowerCase()]||1).padStart(2,'0');
            const year = m[3].length === 2 ? '20' + m[3] : m[3];
            return `${year}-${mon}-${day}`;
        }
        return null;
    }

    cleanString(val) {
        if (!val) return '';
        return String(val).replace(/&#\d+;/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
    }

    async fetchReport(xmlContent) {
        const response = await this.tally.sendXML(xmlContent);
        if (!response) throw new Error('Empty response from Tally');
        if (response.includes('<EXCEPTION>')) {
            const m = response.match(/<EXCEPTION>(.*?)<\/EXCEPTION>/);
            throw new Error(m ? m[1] : 'Tally exception');
        }
        const parsed = this.xmlParser.parse(response);
        const rows = parsed?.DATA?.ROW;
        if (!rows) return [];
        return Array.isArray(rows) ? rows : [rows];
    }

    
    // Parse native Collection XML format for vouchers
    async fetchVoucherCollection(xmlContent) {
        const response = await this.tally.sendXML(xmlContent);
        if (!response) throw new Error('Empty response from Tally');
        if (response.includes('Unknown Request')) throw new Error('Tally rejected the request');
        
        const parser = new (require('fast-xml-parser').XMLParser)({
            ignoreAttributes: false,
            attributeNamePrefix: '@_',
            parseTagValue: false,
            isArray: (tagName) => ['VOUCHER', 'ALLLEDGERENTRIES.LIST'].includes(tagName)
        });
        const parsed = parser.parse(response);
        
        // Helper: extract text value from Tally fields (handles {#text:"val", @_TYPE:"..."} objects)
        const txt = (v) => {
            if (v === null || v === undefined) return '';
            if (typeof v === 'object') return String(v['#text'] || '');
            return String(v);
        };
        const num = (v) => {
            const s = txt(v).trim();
            // Tally uses (1234.56) to denote negative
            const isNegative = /^\(.*\)$/.test(s);
            const clean = parseFloat(s.replace(/[^\d.\-]/g, '')) || 0;
            return isNegative ? -Math.abs(clean) : clean;
        };
        
        // Navigate to the collection of vouchers
        const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;
        if (!collection) return [];
        
        const vouchers = collection['VOUCHER'] || [];
        const rows = [];
        
        for (const v of vouchers) {
            const date = txt(v.DATE);
            const voucherType = txt(v.VOUCHERTYPENAME);
            const voucherNumber = txt(v.VOUCHERNUMBER);
            const partyName = txt(v.PARTYLEDGERNAME);
            const narration = txt(v.NARRATION);
            const voucherAmount = num(v.AMOUNT);
            
            // AllLedgerEntries contains ALL accounting entries (party, tax, sales/purchase acct)
            const entries = v['ALLLEDGERENTRIES.LIST'] || [];

            if (entries.length > 0) {
                for (const entry of entries) {
                    const ledgerName = txt(entry.LEDGERNAME);
                    const amount = num(entry.AMOUNT);
                    rows.push({ date, voucherType, voucherNumber, ledgerName, amount, partyName, narration });
                }
            } else {
                // FIX-23: No AllLedgerEntries (bare Collection API) — store voucher-level data.
                // Use partyName as ledgerName (it's a real Tally ledger under Sundry Debtors/Creditors).
                rows.push({ date, voucherType, voucherNumber, ledgerName: partyName, amount: voucherAmount, partyName, narration });
            }
        }
        
        return rows;
    }

    // Returns true if yearMonth (YYYY-MM) is before the current month
    isHistoricalMonth(yearMonth) {
        return yearMonth < new Date().toISOString().substring(0, 7);
    }

    async withRetry(fn, label) {
        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try { return await fn(); }
            catch (err) {
                // Tally offline — no point retrying, fail immediately
                if (err.message === 'TALLY_NOT_RUNNING' || err.message === 'TALLY_TIMEOUT') throw err;
                if (attempt === this.maxRetries) throw err;
                console.warn(`[RETRY ${attempt}] ${label}: ${err.message}`);
                await new Promise(r => setTimeout(r, 2000 * attempt));
            }
        }
    }

    logSync(companyId, reportType, from, to, status, rowCount = 0, error = null) {
        this.db.prepare(`INSERT INTO sync_log (company_id, report_type, period_from, period_to, status, row_count, error_message, completed_at) VALUES (?,?,?,?,?,?,?,?)`)
            .run(companyId, reportType, from, to, status, rowCount, error, new Date().toISOString());
    }

    async extractChartOfAccounts(companyId, companyName) {
        this.onProgress({ step: 'chart-of-accounts', status: 'running', message: 'Chart of Accounts...' });
        const xml = TEMPLATES['chart-of-accounts'](companyName);
        const rows = await this.withRetry(() => this.fetchReport(xml), 'CoA');
        this.db.prepare('DELETE FROM account_groups WHERE company_id = ?').run(companyId);
        const ins = this.db.prepare('INSERT OR REPLACE INTO account_groups (company_id,group_name,parent_group,bs_pl,dr_cr,affects_gross_profit) VALUES (?,?,?,?,?,?)');
        this.db.transaction((rows) => { for (const r of rows) ins.run(companyId, this.cleanString(r.F01), this.cleanString(r.F02), this.cleanString(r.F03), this.cleanString(r.F04), this.cleanString(r.F05)); })(rows);
        this.logSync(companyId, 'chart-of-accounts', null, null, 'success', rows.length);
        return rows.length;
    }

    async extractLedgers(companyId, companyName) {
        this.onProgress({ step: 'ledgers', status: 'running', message: 'Ledger List...' });
        const xml = TEMPLATES['list-masters']('Ledger', companyName);
        const rows = await this.withRetry(() => this.fetchReport(xml), 'Ledgers');
        this.db.prepare('DELETE FROM ledgers WHERE company_id = ?').run(companyId);
        const ins = this.db.prepare('INSERT OR REPLACE INTO ledgers (company_id,name,group_name) VALUES (?,?,?)');
        this.db.transaction((rows) => { for (const r of rows) ins.run(companyId, this.cleanString(r.F01), this.cleanString(r.F02)); })(rows);
        this.logSync(companyId, 'ledgers', null, null, 'success', rows.length);
        return rows.length;
    }

    async extractTrialBalance(companyId, companyName, fromDate, toDate, forceResync = false) {
        const chunks = this.generateMonthChunks(fromDate, toDate); let total = 0;
        // FIX-20: Force resync purges ALL stale TB data (removes corrupted April anomaly + old quarterly rows)
        if (forceResync) {
            this.db.prepare('DELETE FROM trial_balance WHERE company_id = ?').run(companyId);
        }
        for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i];
            // Skip historical months already synced
            if (!forceResync && this.isHistoricalPeriod(c.to)) {
                const exists = this.db.prepare('SELECT 1 FROM trial_balance WHERE company_id=? AND period_from=? LIMIT 1').get(companyId, c.from);
                if (exists) {
                    this.onProgress({ step: 'trial-balance', status: 'running', message: `Trial Balance: ${c.label} (cached)`, progress: Math.round(((i+1)/chunks.length)*100) });
                    continue;
                }
            }
            this.onProgress({ step: 'trial-balance', status: 'running', message: `Trial Balance: ${c.label}`, progress: Math.round(((i+1)/chunks.length)*100) });
            try {
                const xml = TEMPLATES['trial-balance'](this.formatTallyDate(c.from), this.formatTallyDate(c.to), companyName);
                const rows = await this.withRetry(() => this.fetchReport(xml), `TB ${c.label}`);
                this.db.prepare('DELETE FROM trial_balance WHERE company_id=? AND period_from=? AND period_to=?').run(companyId, c.from, c.to);
                const ins = this.db.prepare('INSERT OR IGNORE INTO trial_balance (company_id,period_from,period_to,ledger_name,group_name,opening_balance,net_debit,net_credit,closing_balance) VALUES (?,?,?,?,?,?,?,?,?)');
                this.db.transaction((rows) => { for (const r of rows) ins.run(companyId, c.from, c.to, this.cleanString(r.F01), this.cleanString(r.F02), this.parseNumber(r.F03), this.parseNumber(r.F04), this.parseNumber(r.F05), this.parseNumber(r.F06)); })(rows);
                total += rows.length; this.logSync(companyId, 'trial-balance', c.from, c.to, 'success', rows.length);
            } catch (e) { this.logSync(companyId, 'trial-balance', c.from, c.to, 'error', 0, e.message); }
        }
        return total;
    }

    async extractProfitLoss(companyId, companyName, fromDate, toDate, forceResync = false) {
        const chunks = this.generateMonthChunks(fromDate, toDate); let total = 0;
        for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i];
            if (!forceResync && this.isHistoricalMonth(c.from.substring(0, 7))) {
                const exists = this.db.prepare('SELECT 1 FROM profit_loss WHERE company_id=? AND period_from=? LIMIT 1').get(companyId, c.from);
                if (exists) {
                    this.onProgress({ step: 'profit-loss', status: 'running', message: `P&L: ${c.label} (cached)`, progress: Math.round(((i+1)/chunks.length)*100) });
                    continue;
                }
            }
            this.onProgress({ step: 'profit-loss', status: 'running', message: `P&L: ${c.label}`, progress: Math.round(((i+1)/chunks.length)*100) });
            try {
                const xml = TEMPLATES['profit-loss'](this.formatTallyDate(c.from), this.formatTallyDate(c.to), companyName);
                const rows = await this.withRetry(() => this.fetchReport(xml), `PL ${c.label}`);
                this.db.prepare('DELETE FROM profit_loss WHERE company_id=? AND period_from=? AND period_to=?').run(companyId, c.from, c.to);
                const ins = this.db.prepare('INSERT OR IGNORE INTO profit_loss (company_id,period_from,period_to,ledger_name,group_name,amount) VALUES (?,?,?,?,?,?)');
                this.db.transaction((rows) => { for (const r of rows) ins.run(companyId, c.from, c.to, this.cleanString(r.F01), this.cleanString(r.F02), this.parseNumber(r.F03)); })(rows);
                total += rows.length; this.logSync(companyId, 'profit-loss', c.from, c.to, 'success', rows.length);
            } catch (e) { this.logSync(companyId, 'profit-loss', c.from, c.to, 'error', 0, e.message); }
        }
        return total;
    }

    async extractBalanceSheet(companyId, companyName, fromDate, toDate, forceResync = false) {
        const chunks = this.generateMonthChunks(fromDate, toDate); let total = 0;
        for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i];
            if (!forceResync && this.isHistoricalMonth(c.from.substring(0, 7))) {
                const exists = this.db.prepare('SELECT 1 FROM balance_sheet WHERE company_id=? AND as_on_date=? LIMIT 1').get(companyId, c.to);
                if (exists) {
                    this.onProgress({ step: 'balance-sheet', status: 'running', message: `Balance Sheet: ${c.label} (cached)`, progress: Math.round(((i+1)/chunks.length)*100) });
                    continue;
                }
            }
            this.onProgress({ step: 'balance-sheet', status: 'running', message: `Balance Sheet: ${c.label}`, progress: Math.round(((i+1)/chunks.length)*100) });
            try {
                const xml = TEMPLATES['balance-sheet'](this.formatTallyDate(fromDate), this.formatTallyDate(c.to), companyName);
                const rows = await this.withRetry(() => this.fetchReport(xml), `BS ${c.label}`);
                this.db.prepare('DELETE FROM balance_sheet WHERE company_id=? AND as_on_date=?').run(companyId, c.to);
                const ins = this.db.prepare('INSERT OR IGNORE INTO balance_sheet (company_id,as_on_date,ledger_name,group_name,closing_balance) VALUES (?,?,?,?,?)');
                this.db.transaction((rows) => { for (const r of rows) ins.run(companyId, c.to, this.cleanString(r.F01), this.cleanString(r.F02), this.parseNumber(r.F03)); })(rows);
                total += rows.length; this.logSync(companyId, 'balance-sheet', null, c.to, 'success', rows.length);
            } catch (e) { this.logSync(companyId, 'balance-sheet', null, c.to, 'error', 0, e.message); }
        }
        return total;
    }

    async extractVouchers(companyId, companyName, fromDate, toDate, forceResync = false) {
        // FIX-23: Bare Collection API — ONE request per month, ALL voucher types.
        //
        // Previous approaches that crashed Tally Prime (YUMM KERALAM):
        //   - WALK + $Owner:$Date → "Bad formula!"
        //   - Collection API + AllLedgerEntries → timeout (15MB+ for 1 week)
        //   - SYSTEM Formulae (NOT $IsCancelled) → "Bad formula!"
        //   - Per-type filters ($VoucherTypeName = "Sales") → "Bad formula!"
        //
        // Working approach (proven): bare Collection API with NATIVEMETHOD only.
        // Returns voucher-level data (Date, VoucherTypeName, VoucherNumber,
        // PartyLedgerName, Amount, Narration). No sub-collections, no filters.
        // 13,384 vouchers in 3.1s for full year — fast and reliable.
        //
        // Result: 12 requests/year (1 per month) instead of 96.

        const chunks = this.generateMonthChunks(fromDate, toDate);
        let total = 0;

        const ins = this.db.prepare(
            'INSERT OR IGNORE INTO vouchers (company_id,date,voucher_type,voucher_number,ledger_name,amount,party_name,narration,sync_month) VALUES (?,?,?,?,?,?,?,?,?)'
        );

        // ── Phase 1: Smart-skip check + DELETE stale data ─────────────────────────
        const activeChunks = [];
        for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i];
            const syncMonth = c.from.substring(0, 7);

            if (!forceResync && this.isHistoricalMonth(syncMonth)) {
                const exists = this.db.prepare(
                    'SELECT 1 FROM vouchers WHERE company_id=? AND date >= ? AND date <= ? LIMIT 1'
                ).get(companyId, c.from, c.to);
                if (exists) {
                    this.onProgress({ step: 'vouchers', status: 'running',
                        message: `Vouchers: ${c.label} (cached)`,
                        progress: Math.round(((i + 1) / chunks.length) * 100) });
                    continue;
                }
            }

            this.db.prepare('DELETE FROM vouchers WHERE company_id=? AND date >= ? AND date <= ?')
                .run(companyId, c.from, c.to);
            activeChunks.push({ ...c, syncMonth });
        }

        if (activeChunks.length === 0) {
            this.onProgress({ step: 'vouchers', status: 'running',
                message: 'Vouchers: all months cached', progress: 100 });
            this.logSync(companyId, 'vouchers', fromDate, toDate, 'success', 0);
            return 0;
        }

        // Helper: parse date from Tally's YYYYMMDD or DD-Mon-YYYY format
        const parseTallyDate = (dateStr, fallback) => {
            if (!dateStr) return fallback;
            const s = String(dateStr).trim();
            if (/^\d{8}$/.test(s)) return s.substring(0, 4) + '-' + s.substring(4, 6) + '-' + s.substring(6, 8);
            return this.parseDate(s) || fallback;
        };

        // ── Phase 2: ONE request per month — all voucher types ────────────────────
        for (let i = 0; i < activeChunks.length; i++) {
            const c = activeChunks[i];
            this.onProgress({ step: 'vouchers', status: 'running',
                message: `Vouchers: ${c.label} (${i + 1}/${activeChunks.length})`,
                progress: Math.round(((i + 1) / activeChunks.length) * 100) });

            let rows = [];
            try {
                const xml = TEMPLATES['daybook'](
                    this.formatTallyDate(c.from), this.formatTallyDate(c.to), companyName
                );
                console.log(`[Sync] Requesting vouchers ${c.label} from Tally...`);
                const t0 = Date.now();
                rows = await this.withRetry(() => this.fetchVoucherCollection(xml), `V ${c.label}`);
                console.log(`[Sync] Vouchers ${c.label}: got ${rows.length} rows in ${((Date.now()-t0)/1000).toFixed(1)}s`);
            } catch (e) {
                console.error(`[Sync] Vouchers ${c.label} FAILED: ${e.message}`);
                this.logSync(companyId, 'vouchers', c.from, c.to, 'error', 0, e.message);
                continue;
            }

            if (!rows.length) continue;

            // Filter to current month window and insert
            const validRows = rows.filter(r => {
                const d = parseTallyDate(r.date, c.from);
                return d >= c.from && d <= c.to;
            });
            if (!validRows.length) continue;

            this.db.transaction((vRows) => {
                for (const r of vRows) {
                    ins.run(companyId, parseTallyDate(r.date, c.from),
                        r.voucherType || '', r.voucherNumber || '',
                        r.ledgerName || '', r.amount,
                        r.partyName || '', r.narration || '', c.syncMonth);
                }
            })(validRows);
            total += validRows.length;
        }

        this.logSync(companyId, 'vouchers', fromDate, toDate, 'success', total);
        return total;
    }

    async extractStockSummary(companyId, companyName, fromDate, toDate, forceResync = false) {
        const chunks = this.generateQuarterChunks(fromDate, toDate); let total = 0;
        for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i];
            if (!forceResync && this.isHistoricalPeriod(c.to)) {
                const exists = this.db.prepare('SELECT 1 FROM stock_summary WHERE company_id=? AND period_from=? LIMIT 1').get(companyId, c.from);
                if (exists) {
                    this.onProgress({ step: 'stock-summary', status: 'running', message: `Stock: ${c.label} (cached)`, progress: Math.round(((i+1)/chunks.length)*100) });
                    continue;
                }
            }
            this.onProgress({ step: 'stock-summary', status: 'running', message: `Stock: ${c.label}`, progress: Math.round(((i+1)/chunks.length)*100) });
            try {
                const xml = TEMPLATES['stock-summary'](this.formatTallyDate(c.from), this.formatTallyDate(c.to), companyName);
                const rows = await this.withRetry(() => this.fetchReport(xml), `Stock ${c.label}`);
                this.db.prepare('DELETE FROM stock_summary WHERE company_id=? AND period_from=? AND period_to=?').run(companyId, c.from, c.to);
                const ins = this.db.prepare('INSERT OR IGNORE INTO stock_summary (company_id,period_from,period_to,item_name,stock_group,opening_qty,opening_value,inward_qty,inward_value,outward_qty,outward_value,closing_qty,closing_value) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
                this.db.transaction((rows) => { for (const r of rows) ins.run(companyId, c.from, c.to, this.cleanString(r.F01), this.cleanString(r.F02), this.parseNumber(r.F03), this.parseNumber(r.F04), this.parseNumber(r.F05), this.parseNumber(r.F06), this.parseNumber(r.F07), this.parseNumber(r.F08), this.parseNumber(r.F09), this.parseNumber(r.F10)); })(rows);
                total += rows.length; this.logSync(companyId, 'stock-summary', c.from, c.to, 'success', rows.length);
            } catch (e) { this.logSync(companyId, 'stock-summary', c.from, c.to, 'error', 0, e.message); }
        }
        return total;
    }

    async extractBillsOutstanding(companyId, companyName, toDate) {
        for (const nature of ['receivable','payable']) {
            this.onProgress({ step: 'bills', status: 'running', message: `Bills: ${nature}` });
            try {
                const xml = TEMPLATES['bills-outstanding'](this.formatTallyDate(toDate), nature, companyName);
                const rows = await this.withRetry(() => this.fetchReport(xml), `Bills ${nature}`);
                this.db.prepare('DELETE FROM bills_outstanding WHERE company_id=? AND as_on_date=? AND nature=?').run(companyId, toDate, nature);
                const ins = this.db.prepare('INSERT INTO bills_outstanding (company_id,as_on_date,nature,bill_date,reference_number,outstanding_amount,party_name,overdue_days) VALUES (?,?,?,?,?,?,?,?)');
                this.db.transaction((rows) => { for (const r of rows) ins.run(companyId, toDate, nature, this.parseDate(r.F01), this.cleanString(r.F02), this.parseNumber(r.F03), this.cleanString(r.F04), this.parseNumber(r.F05)); })(rows);
                this.logSync(companyId, `bills-${nature}`, null, toDate, 'success', rows.length);
            } catch (e) { this.logSync(companyId, `bills-${nature}`, null, toDate, 'error', 0, e.message); }
        }
    }

    // ── OPTIONAL MODULE EXTRACTORS ────────────────────────────────────────────
    // Each method: catches all errors, logs "skipped" / "not available", returns 0.
    // Never throws to parent sync — safe if Tally module is disabled.

    async extractCostCentres(companyId, companyName) {
        this.onProgress({ step: 'costCentres', status: 'running', message: 'Cost Centres: fetching master list...' });
        try {
            const xml = TEMPLATES['cost-centres'](companyName);
            const rows = await this.withRetry(() => this.fetchReport(xml), 'CostCentres');
            if (!rows.length) {
                this.logSync(companyId, 'cost-centres', null, null, 'success', 0);
                return 0;
            }
            this.db.prepare('DELETE FROM cost_centres WHERE company_id = ?').run(companyId);
            const ins = this.db.prepare('INSERT OR REPLACE INTO cost_centres (company_id,name,parent,category) VALUES (?,?,?,?)');
            this.db.transaction((rows) => {
                for (const r of rows) ins.run(companyId, this.cleanString(r.F01), this.cleanString(r.F02), this.cleanString(r.F03));
            })(rows);
            this.logSync(companyId, 'cost-centres', null, null, 'success', rows.length);
            return rows.length;
        } catch (e) {
            console.warn(`[Cost Centres] Not available or error: ${e.message}`);
            this.logSync(companyId, 'cost-centres', null, null, 'error', 0, e.message);
            return 0;
        }
    }

    async extractCostAllocations(companyId, companyName, fromDate, toDate, forceResync = false) {
        const chunks = this.generateQuarterChunks(fromDate, toDate);
        let total = 0;
        for (const c of chunks) {
            if (!forceResync && this.isHistoricalPeriod(c.to)) {
                const exists = this.db.prepare('SELECT 1 FROM cost_allocations WHERE company_id=? AND date=? LIMIT 1').get(companyId, c.to);
                if (exists) continue;
            }
            this.onProgress({ step: 'costAlloc', status: 'running', message: `Cost Allocations: ${c.label}` });
            try {
                const xml = TEMPLATES['cost-allocations'](this.formatTallyDate(c.from), this.formatTallyDate(c.to), companyName);
                const rows = await this.withRetry(() => this.fetchReport(xml), `CostAlloc ${c.label}`);
                this.db.prepare('DELETE FROM cost_allocations WHERE company_id=? AND date=? AND sync_month=?').run(companyId, c.to, c.from.substring(0, 7));
                const ins = this.db.prepare('INSERT OR IGNORE INTO cost_allocations (company_id,date,ledger_name,cost_centre,amount,sync_month) VALUES (?,?,?,?,?,?)');
                this.db.transaction((rows) => {
                    for (const r of rows) {
                        const ledger = this.cleanString(r.F01);
                        const cc = this.cleanString(r.F02);
                        if (cc) ins.run(companyId, c.to, ledger, cc, this.parseNumber(r.F04), c.from.substring(0, 7));
                    }
                })(rows);
                total += rows.length;
                this.logSync(companyId, 'cost-allocations', c.from, c.to, 'success', rows.length);
            } catch (e) {
                console.warn(`[Cost Alloc ${c.label}] Not available: ${e.message}`);
                this.logSync(companyId, 'cost-allocations', c.from, c.to, 'error', 0, e.message);
            }
        }
        return total;
    }

    async extractGstEntries(companyId, companyName, fromDate, toDate, forceResync = false) {
        // FIX-23: Fetch ALL vouchers once per month, filter GST types in JS.
        // (daybook template no longer supports Tally-side type filtering)
        const chunks = this.generateMonthChunks(fromDate, toDate);
        const gstTypeSet = new Set(['Sales', 'Purchase', 'Credit Note', 'Debit Note']);
        let total = 0;

        const insGst = this.db.prepare(
            'INSERT OR IGNORE INTO gst_entries (company_id,date,voucher_type,voucher_number,party_name,taxable_value,sync_month) VALUES (?,?,?,?,?,?,?)'
        );

        const parseTallyDate = (dateStr, fallback) => {
            if (!dateStr) return fallback;
            const s = String(dateStr).trim();
            if (/^\d{8}$/.test(s)) return s.substring(0, 4) + '-' + s.substring(4, 6) + '-' + s.substring(6, 8);
            return this.parseDate(s) || fallback;
        };

        for (const c of chunks) {
            const syncMonth = c.from.substring(0, 7);
            if (!forceResync && this.isHistoricalMonth(syncMonth)) {
                const exists = this.db.prepare('SELECT 1 FROM gst_entries WHERE company_id=? AND sync_month=? LIMIT 1').get(companyId, syncMonth);
                if (exists) continue;
            }
            this.onProgress({ step: 'gst', status: 'running', message: `GST Entries: ${c.label}` });
            this.db.prepare('DELETE FROM gst_entries WHERE company_id=? AND sync_month=?').run(companyId, syncMonth);
            try {
                const xml = TEMPLATES['daybook'](this.formatTallyDate(c.from), this.formatTallyDate(c.to), companyName);
                const rows = await this.withRetry(() => this.fetchVoucherCollection(xml), `GST ${c.label}`);

                // Filter to GST types and aggregate per voucher
                const voucherMap = new Map();
                for (const r of rows) {
                    if (!gstTypeSet.has(r.voucherType)) continue;
                    const key = `${r.date}||${r.voucherNumber}||${r.voucherType}`;
                    if (!voucherMap.has(key)) voucherMap.set(key, { date: r.date, voucherType: r.voucherType, voucherNumber: r.voucherNumber, partyName: r.partyName, totalAmt: 0 });
                    voucherMap.get(key).totalAmt += Math.abs(r.amount);
                }

                this.db.transaction((entries) => {
                    for (const [, v] of entries) {
                        const d = parseTallyDate(v.date, c.from);
                        if (d >= c.from && d <= c.to) {
                            insGst.run(companyId, d, v.voucherType, v.voucherNumber || '', v.partyName || '', v.totalAmt, syncMonth);
                            total++;
                        }
                    }
                })(voucherMap);
            } catch (e) {
                console.warn(`[GST ${c.label}] ${e.message}`);
            }
            this.logSync(companyId, 'gst-entries', c.from, c.to, 'success', total);
        }
        return total;
    }

    async extractPayroll(companyId, companyName, fromDate, toDate, forceResync = false) {
        // FIX-23: Fetch all vouchers, filter voucherType === 'Payroll' in JS
        const chunks = this.generateMonthChunks(fromDate, toDate);
        let total = 0;
        const ins = this.db.prepare(
            'INSERT OR IGNORE INTO payroll_entries (company_id,date,voucher_number,employee_name,pay_head,amount,sync_month) VALUES (?,?,?,?,?,?,?)'
        );

        const parseTallyDate = (dateStr, fallback) => {
            if (!dateStr) return fallback;
            const s = String(dateStr).trim();
            if (/^\d{8}$/.test(s)) return s.substring(0, 4) + '-' + s.substring(4, 6) + '-' + s.substring(6, 8);
            return this.parseDate(s) || fallback;
        };

        for (const c of chunks) {
            const syncMonth = c.from.substring(0, 7);
            if (!forceResync && this.isHistoricalMonth(syncMonth)) {
                const exists = this.db.prepare('SELECT 1 FROM payroll_entries WHERE company_id=? AND sync_month=? LIMIT 1').get(companyId, syncMonth);
                if (exists) continue;
            }
            this.onProgress({ step: 'payroll', status: 'running', message: `Payroll: ${c.label}` });
            try {
                const xml = TEMPLATES['daybook'](this.formatTallyDate(c.from), this.formatTallyDate(c.to), companyName);
                const allRows = await this.withRetry(() => this.fetchVoucherCollection(xml), `Payroll ${c.label}`);
                // Filter to Payroll voucher type only
                const rows = allRows.filter(r => r.voucherType === 'Payroll');
                if (!rows.length) {
                    this.logSync(companyId, 'payroll', c.from, c.to, 'success', 0);
                    continue;
                }
                this.db.prepare('DELETE FROM payroll_entries WHERE company_id=? AND sync_month=?').run(companyId, syncMonth);
                this.db.transaction((rows) => {
                    for (const r of rows) {
                        const d = parseTallyDate(r.date, c.from);
                        if (d >= c.from && d <= c.to) {
                            ins.run(companyId, d, r.voucherNumber || '', r.partyName || '', r.ledgerName || '', r.amount, syncMonth);
                            total++;
                        }
                    }
                })(rows);
                this.logSync(companyId, 'payroll', c.from, c.to, 'success', rows.length);
            } catch (e) {
                console.warn(`[Payroll ${c.label}] Not available: ${e.message}`);
                this.logSync(companyId, 'payroll', c.from, c.to, 'error', 0, e.message);
            }
        }
        return total;
    }

    // On-demand stock item ledger — not in runFullSync, called by API endpoint.
    async extractStockItemLedger(companyId, companyName, itemName, fromDate, toDate) {
        this.onProgress({ step: 'stockLedger', status: 'running', message: `Stock Ledger: ${itemName}...` });
        try {
            const xml = TEMPLATES['stock-item-ledger'](
                this.formatTallyDate(fromDate), this.formatTallyDate(toDate), companyName
            );
            const response = await this.tally.sendXML(xml);
            if (!response) throw new Error('Empty response from Tally');

            const parser = new (require('fast-xml-parser').XMLParser)({
                ignoreAttributes: false,
                attributeNamePrefix: '@_',
                parseTagValue: false,
                isArray: (t) => ['VOUCHER', 'ALLLEDGERENTRIES.LIST', 'ALLINVENTORYENTRIES.LIST'].includes(t)
            });
            const parsed = parser.parse(response);
            const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;
            if (!collection) return 0;

            const txt = (v) => (v === null || v === undefined) ? '' : typeof v === 'object' ? String(v['#text'] || '') : String(v);
            const num = (v) => {
                const s = txt(v).trim();
                const isNeg = /^\(.*\)$/.test(s);
                const clean = parseFloat(s.replace(/[^\d.\-]/g, '')) || 0;
                return isNeg ? -Math.abs(clean) : clean;
            };

            const vouchers = collection['VOUCHER'] || [];
            const ins = this.db.prepare(
                'INSERT OR IGNORE INTO stock_item_ledger (company_id,date,item_name,voucher_type,voucher_number,party_name,quantity,amount,sync_month) VALUES (?,?,?,?,?,?,?,?,?)'
            );

            this.db.prepare('DELETE FROM stock_item_ledger WHERE company_id=? AND item_name=? AND date>=? AND date<=?')
                .run(companyId, itemName, fromDate, toDate);

            let total = 0;
            this.db.transaction((vouchers) => {
                for (const v of vouchers) {
                    const date = (() => {
                        const d = txt(v.DATE);
                        if (d.length === 8 && /^\d{8}$/.test(d)) return `${d.substring(0,4)}-${d.substring(4,6)}-${d.substring(6,8)}`;
                        return this.parseDate(d) || fromDate;
                    })();
                    if (date < fromDate || date > toDate) continue;

                    const vt = txt(v.VOUCHERTYPENAME);
                    const vn = txt(v.VOUCHERNUMBER);
                    const party = txt(v.PARTYLEDGERNAME);
                    const syncMonth = date.substring(0, 7);

                    const invEntries = v['ALLINVENTORYENTRIES.LIST'] || [];
                    for (const ie of invEntries) {
                        const iName = txt(ie.STOCKITEMNAME);
                        if (!iName || iName.toLowerCase() !== itemName.toLowerCase()) continue;
                        const qty = num(ie.ACTUALQTY || ie.BILLEDQTY);
                        const amt = num(ie.AMOUNT);
                        ins.run(companyId, date, itemName, vt, vn, party, qty, amt, syncMonth);
                        total++;
                    }
                }
            })(vouchers);

            this.logSync(companyId, 'stock-item-ledger', fromDate, toDate, 'success', total);
            return total;
        } catch (e) {
            console.warn(`[StockItemLedger] Error: ${e.message}`);
            this.logSync(companyId, 'stock-item-ledger', fromDate, toDate, 'error', 0, e.message);
            return 0;
        }
    }

    async runFullSync(companyId, companyName, fromDate, toDate, options = {}) {
        const forceResync = options.forceResync || false;
        const start = Date.now(); const results = { success: true, errors: [], counts: {}, forceResync };
        this.onProgress({ step: 'init', status: 'running', message: `Syncing ${companyName}: ${fromDate} to ${toDate}${forceResync ? ' (force)' : ' (incremental)'}` });

        const modules = options.syncModules || {};
        const steps = [
            ['groups',        () => this.extractChartOfAccounts(companyId, companyName)],
            ['ledgers',       () => this.extractLedgers(companyId, companyName)],
            ['trialBalance',  () => this.extractTrialBalance(companyId, companyName, fromDate, toDate, forceResync)],
            ['stockSummary',  () => this.extractStockSummary(companyId, companyName, fromDate, toDate, forceResync)],
            ['vouchers',      () => this.extractVouchers(companyId, companyName, fromDate, toDate, forceResync)],
            ['bills',         () => this.extractBillsOutstanding(companyId, companyName, toDate)],
            // Optional modules — only run when enabled per company
            ...(modules.gst         ? [['gst',          () => this.extractGstEntries(companyId, companyName, fromDate, toDate, forceResync)]] : []),
            ...(modules.costCentres ? [['costCentres',   () => this.extractCostCentres(companyId, companyName)],
                                       ['costAlloc',     () => this.extractCostAllocations(companyId, companyName, fromDate, toDate, forceResync)]] : []),
            ...(modules.payroll     ? [['payroll',       () => this.extractPayroll(companyId, companyName, fromDate, toDate, forceResync)]] : []),
        ];

        for (const [name, fn] of steps) {
            try { results.counts[name] = await fn(); }
            catch (e) { results.errors.push(`${name}: ${e.message}`); }
        }

        this.db.prepare('UPDATE companies SET last_full_sync_at=?, sync_from_date=?, sync_to_date=? WHERE id=?')
            .run(new Date().toISOString(), fromDate, toDate, companyId);

        results.durationMs = Date.now() - start;
        results.success = results.errors.length === 0;
        this.onProgress({ step: 'complete', status: results.success ? 'done' : 'partial', message: `Done in ${Math.round(results.durationMs/1000)}s`, results });
        return results;
    }
}

module.exports = { DataExtractor };

