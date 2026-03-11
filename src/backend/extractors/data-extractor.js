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
                // Fallback: no ledger entries — store voucher-level amount only
                rows.push({ date, voucherType, voucherNumber, ledgerName: '', amount: voucherAmount, partyName, narration });
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
        for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i];
            // Skip historical months already synced
            if (!forceResync && this.isHistoricalMonth(c.from.substring(0, 7))) {
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
        // FIX-13: Fetch-once-per-type architecture.
        //
        // Tally's Collection API always returns the currently-active Tally period's
        // vouchers regardless of SVFROMDATE/SVTODATE. Fetching the same data 12 times
        // (once per month) is wasteful — 96 requests for a 12-month FY sync.
        //
        // New approach:
        //   Phase 1 — determine which months need syncing, DELETE stale rows.
        //   Phase 2 — ONE Tally request per voucher type (8 total), parse all vouchers,
        //             distribute to the correct month buckets using validRows.
        //
        // Result: 8 requests instead of 96 → ~12x faster (seconds, not minutes).

        const chunks = this.generateMonthChunks(fromDate, toDate);
        const types = ['Sales','Purchase','Receipt','Payment','Journal','Contra','Credit Note','Debit Note'];
        let total = 0;

        const ins = this.db.prepare(
            'INSERT OR IGNORE INTO vouchers (company_id,date,voucher_type,voucher_number,ledger_name,amount,party_name,narration,sync_month) VALUES (?,?,?,?,?,?,?,?,?)'
        );

        // ── Phase 1: Smart-skip check + DELETE stale data ─────────────────────────
        const activeChunks = []; // months that actually need Tally data
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

            // Month needs refresh — clear any stale rows before inserting fresh data
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

        // ── Phase 2: One request per voucher type ─────────────────────────────────
        for (let j = 0; j < types.length; j++) {
            const vt = types[j];
            this.onProgress({ step: 'vouchers', status: 'running',
                message: `Vouchers: fetching ${vt} (${j + 1}/${types.length})`,
                progress: Math.round((j / types.length) * 100) });

            let rows = [];
            try {
                // Pass the full sync range — SVFROMDATE/SVTODATE are hints only; Tally
                // returns its active period. validRows distributes data to month buckets.
                const xml = TEMPLATES['daybook'](
                    this.formatTallyDate(fromDate), this.formatTallyDate(toDate), companyName, vt
                );
                console.log(`[Sync] Requesting ${vt} from Tally...`);
                const t0 = Date.now();
                rows = await this.withRetry(() => this.fetchVoucherCollection(xml), `V ${vt}`);
                console.log(`[Sync] ${vt}: got ${rows.length} ledger rows in ${((Date.now()-t0)/1000).toFixed(1)}s`);
            } catch (e) {
                console.error(`[Sync] ${vt} FAILED: ${e.message}`);
                this.logSync(companyId, `vouchers-${vt}`, fromDate, toDate, 'error', 0, e.message);
                continue;
            }

            if (!rows.length) { console.log(`[Sync] ${vt}: 0 rows, skipping`); continue; }

            // Parse all dates once upfront
            const parsedRows = rows.map(r => {
                let parsedDate = fromDate;
                if (r.date && r.date.length === 8 && /^\d{8}$/.test(r.date)) {
                    parsedDate = r.date.substring(0, 4) + '-' + r.date.substring(4, 6) + '-' + r.date.substring(6, 8);
                } else if (r.date) {
                    parsedDate = this.parseDate(r.date) || fromDate;
                }
                return { ...r, parsedDate };
            });

            // Distribute to each active (uncached) month bucket
            for (const c of activeChunks) {
                const validRows = parsedRows.filter(r => r.parsedDate >= c.from && r.parsedDate <= c.to);
                if (!validRows.length) continue;

                this.db.transaction((vRows) => {
                    for (const r of vRows) {
                        ins.run(companyId, r.parsedDate, r.voucherType || vt,
                            r.voucherNumber || '', r.ledgerName || '',
                            r.amount, r.partyName, r.narration, c.syncMonth);
                    }
                })(validRows);
                total += validRows.length;
            }

            this.onProgress({ step: 'vouchers', status: 'running',
                message: `Vouchers: ${vt} done`,
                progress: Math.round(((j + 1) / types.length) * 100) });
        }

        this.logSync(companyId, 'vouchers', fromDate, toDate, 'success', total);
        return total;
    }

    async extractStockSummary(companyId, companyName, fromDate, toDate, forceResync = false) {
        const chunks = this.generateMonthChunks(fromDate, toDate); let total = 0;
        for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i];
            if (!forceResync && this.isHistoricalMonth(c.from.substring(0, 7))) {
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

    async runFullSync(companyId, companyName, fromDate, toDate, options = {}) {
        const forceResync = options.forceResync || false;
        const start = Date.now(); const results = { success: true, errors: [], counts: {}, forceResync };
        this.onProgress({ step: 'init', status: 'running', message: `Syncing ${companyName}: ${fromDate} to ${toDate}${forceResync ? ' (force)' : ' (incremental)'}` });

        const steps = [
            ['groups', () => this.extractChartOfAccounts(companyId, companyName)],
            ['ledgers', () => this.extractLedgers(companyId, companyName)],
            ['trialBalance', () => this.extractTrialBalance(companyId, companyName, fromDate, toDate, forceResync)],
            ['profitLoss', () => this.extractProfitLoss(companyId, companyName, fromDate, toDate, forceResync)],
            ['balanceSheet', () => this.extractBalanceSheet(companyId, companyName, fromDate, toDate, forceResync)],
            ['stockSummary', () => this.extractStockSummary(companyId, companyName, fromDate, toDate, forceResync)],
            ['vouchers', () => this.extractVouchers(companyId, companyName, fromDate, toDate, forceResync)],
            ['bills', () => this.extractBillsOutstanding(companyId, companyName, toDate)],
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

