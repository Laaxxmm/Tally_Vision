/**
 * TallyVision - REST API Server (v4 - Dynamic TB, Optimized)
 * In-memory ledger→group mapping for fast voucher aggregation
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDatabase, getDbPath } = require('./db/setup');
const { TallyConnector } = require('./tally-connector');
const { DataExtractor } = require('./extractors/data-extractor');

const app = express();
app.use(cors());
app.use(express.json());

// Serve frontend
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'dashboard.html'));
});

// Initialize database
const db = initDatabase();

// State
let syncInProgress = false;
let syncProgress = null;

// Helper: get/set setting
function getSetting(key) {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row ? row.value : null;
}
function setSetting(key, value) {
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, new Date().toISOString());
}

// ============================================================
//  DYNAMIC TB ENGINE (Optimized - in-memory lookups)
// ============================================================

/**
 * Get all child groups of a parent (recursive tree walk)
 */
function getGroupTree(companyId, parentName) {
    const allGroups = db.prepare('SELECT DISTINCT group_name, parent_group FROM account_groups WHERE company_id = ?').all(companyId);
    const result = new Set([parentName]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const g of allGroups) {
            if (result.has(g.parent_group) && !result.has(g.group_name)) {
                result.add(g.group_name);
                changed = true;
            }
        }
    }
    return [...result];
}

/**
 * Build ledger_name → group_name map from trial_balance (fast, ~8ms)
 */
function buildLedgerGroupMap(companyId) {
    const rows = db.prepare('SELECT DISTINCT ledger_name, group_name FROM trial_balance WHERE company_id = ?').all(companyId);
    const map = {};
    rows.forEach(r => { map[r.ledger_name] = r.group_name; });
    return map;
}

/**
 * Build P&L group sets using account_groups metadata fields.
 * Catches ALL groups including custom ones not descended from standard Tally names.
 * directCredit  = (PL, C, Y) → Sales Accounts + Direct Incomes + custom
 * directDebit   = (PL, D, Y) → Purchase Accounts + Direct Expenses + custom
 * indirectCredit= (PL, C, N) → Indirect Incomes + custom
 * indirectDebit = (PL, D, N) → Indirect Expenses + custom
 */
function buildPLGroupSets(companyId) {
    const groups = db.prepare(
        `SELECT group_name, dr_cr, affects_gross_profit FROM account_groups WHERE company_id = ? AND bs_pl = 'PL'`
    ).all(companyId);
    const sets = { directCredit: new Set(), indirectCredit: new Set(), directDebit: new Set(), indirectDebit: new Set() };
    for (const g of groups) {
        if      (g.dr_cr === 'C' && g.affects_gross_profit === 'Y') sets.directCredit.add(g.group_name);
        else if (g.dr_cr === 'C' && g.affects_gross_profit === 'N') sets.indirectCredit.add(g.group_name);
        else if (g.dr_cr === 'D' && g.affects_gross_profit === 'Y') sets.directDebit.add(g.group_name);
        else if (g.dr_cr === 'D' && g.affects_gross_profit === 'N') sets.indirectDebit.add(g.group_name);
    }
    return sets;
}

/**
 * FIX-19/FIX-20: TB supplement for P&L ledgers.
 * Returns rows { ledger_name, group_name, net_debit, net_credit } for ALL P&L ledgers
 * found in the trial_balance for [from, to].
 *
 * Caller uses these rows to compute top-up adjustments:
 *   - For zero-voucher ledgers: full TB net is added
 *   - For with-voucher ledgers: only the gap (TB net − voucher contribution) is added
 *   See the TB top-up loop in the KPI handler (/api/dashboard/kpi) for the hybrid formula.
 *
 * FIX-20: April-anomaly guard — if the DB still has stale April data (full-year values
 * FIX-20: TB extraction now uses monthly chunks (generateMonthChunks) with blanket
 * DELETE on force resync, so April data is always correct per-month values.
 * The old isFullFY guard has been removed — all date ranges are safe post-resync.
 */
function getTBSupplement(companyId, from, to) {
    // Unified path: sum all monthly TB records within [from, to].
    // Dedup: when a ledger has overlapping records for the same period_from
    // (e.g., old quarterly + new monthly), keep only the shortest-span record.
    const resultMap = {};
    const tbRows = db.prepare(`
        SELECT ledger_name, group_name,
               SUM(net_debit)  AS net_debit,
               SUM(net_credit) AS net_credit
        FROM trial_balance t
        WHERE company_id = ?
          AND period_from >= ?
          AND period_to   <= ?
          AND group_name IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM trial_balance t2
              WHERE t2.company_id = t.company_id
                AND t2.ledger_name = t.ledger_name
                AND t2.period_from = t.period_from
                AND t2.period_to < t.period_to
          )
        GROUP BY ledger_name, group_name
    `).all(companyId, from, to);
    for (const r of tbRows) {
        resultMap[r.ledger_name] = { group_name: r.group_name, net_debit: r.net_debit || 0, net_credit: r.net_credit || 0 };
    }

    return Object.entries(resultMap).map(([ledger_name, v]) => ({ ledger_name, ...v }));
}

/**
 * Get voucher totals grouped by ledger for a date range (fast, ~15ms, no JOINs)
 */
function getVouchersByLedger(companyId, fromDate, toDate) {
    return db.prepare(`
        SELECT ledger_name, SUM(amount) as total
        FROM vouchers
        WHERE company_id = ? AND date >= ? AND date <= ? AND ledger_name != ''
        GROUP BY ledger_name
    `).all(companyId, fromDate, toDate);
}

/**
 * P&L Flow: Sum voucher amounts for ledgers belonging to target groups
 * Uses in-memory map instead of SQL JOIN
 */
function computePLFlow(vouchersByLedger, lgMap, groupSet) {
    let total = 0;
    for (const row of vouchersByLedger) {
        const grp = lgMap[row.ledger_name];
        if (grp && groupSet.has(grp)) {
            total += row.total;
        }
    }
    return total;
}

/**
 * BS Closing Balance: TB opening + voucher movements up to asOfDate
 * Uses in-memory map, no JOINs
 */
function computeBSClosing(companyId, asOfDate, groupNames, balanceFilter, lgMap) {
    if (!groupNames.length) return 0;
    const groupSet = new Set(groupNames);
    const ph = groupNames.map(() => '?').join(',');

    // Find the TB month containing/preceding asOfDate
    const tbMonth = db.prepare(`
        SELECT DISTINCT period_from, period_to FROM trial_balance
        WHERE company_id = ? AND period_from <= ?
        ORDER BY period_from DESC LIMIT 1
    `).get(companyId, asOfDate);

    if (!tbMonth) return 0;

    // Get TB opening balances for target groups
    const tbRows = db.prepare(`
        SELECT ledger_name, opening_balance FROM trial_balance
        WHERE company_id = ? AND period_from = ? AND group_name IN (${ph})
    `).all(companyId, tbMonth.period_from, ...groupNames);

    // Get voucher movements (no JOIN - simple query)
    const vRows = db.prepare(`
        SELECT ledger_name, SUM(amount) as movement
        FROM vouchers
        WHERE company_id = ? AND date >= ? AND date <= ? AND ledger_name != ''
        GROUP BY ledger_name
    `).all(companyId, tbMonth.period_from, asOfDate);

    // Filter voucher rows to target groups using in-memory map
    const movementMap = {};
    for (const r of vRows) {
        const grp = lgMap[r.ledger_name];
        if (grp && groupSet.has(grp)) {
            movementMap[r.ledger_name] = r.movement;
        }
    }

    // Compute per-ledger closing
    let total = 0;
    const ledgersSeen = new Set();

    for (const r of tbRows) {
        ledgersSeen.add(r.ledger_name);
        const closing = r.opening_balance + (movementMap[r.ledger_name] || 0);
        if (balanceFilter === 'debit' && closing < 0) total += closing;
        else if (balanceFilter === 'credit' && closing > 0) total += closing;
        else if (!balanceFilter) total += closing;
    }

    // Voucher-only ledgers (in target groups but no TB row)
    for (const [ledger, movement] of Object.entries(movementMap)) {
        if (!ledgersSeen.has(ledger)) {
            if (balanceFilter === 'debit' && movement < 0) total += movement;
            else if (balanceFilter === 'credit' && movement > 0) total += movement;
            else if (!balanceFilter) total += movement;
        }
    }

    return total;
}

/**
 * Get top ledgers by amount for specific groups (for bar charts)
 */
function getTopLedgers(vouchersByLedger, lgMap, groupSet, limit, negate) {
    const results = [];
    for (const row of vouchersByLedger) {
        const grp = lgMap[row.ledger_name];
        if (grp && groupSet.has(grp)) {
            const val = negate ? -row.total : row.total;
            if (val > 0) {
                results.push({ ledger_name: row.ledger_name, group_name: grp, total: val });
            }
        }
    }
    results.sort((a, b) => b.total - a.total);
    return results.slice(0, limit || 10);
}

/**
 * Get totals by group (for pie charts)
 */
function getTotalsByGroup(vouchersByLedger, lgMap, groupSet, negate) {
    const groupTotals = {};
    for (const row of vouchersByLedger) {
        const grp = lgMap[row.ledger_name];
        if (grp && groupSet.has(grp)) {
            groupTotals[grp] = (groupTotals[grp] || 0) + row.total;
        }
    }
    const results = [];
    for (const [category, total] of Object.entries(groupTotals)) {
        const val = negate ? -total : total;
        if (val > 0) results.push({ category, total: val });
    }
    results.sort((a, b) => b.total - a.total);
    return results;
}

/**
 * Get monthly breakdown from vouchers (for trend charts)
 */
function getMonthlyVouchers(companyId, fromDate, toDate) {
    return db.prepare(`
        SELECT strftime('%Y-%m-01', date) as month, ledger_name, SUM(amount) as total
        FROM vouchers
        WHERE company_id = ? AND date >= ? AND date <= ? AND ledger_name != ''
        GROUP BY strftime('%Y-%m', date), ledger_name
    `).all(companyId, fromDate, toDate);
}


// ===== HEALTH & STATUS =====

app.get('/api/status', async (req, res) => {
    const host = getSetting('tally_host') || 'localhost';
    const port = parseInt(getSetting('tally_port') || '9000');
    const tally = new TallyConnector({ host, port });
    const health = await tally.healthCheck();
    const companies = db.prepare('SELECT * FROM companies WHERE is_active = 1 ORDER BY last_full_sync_at DESC').all();
    res.json({
        tally: health,
        database: { path: getDbPath(), companies },
        sync: { inProgress: syncInProgress, progress: syncProgress }
    });
});

// ===== TALLY CONNECTION =====

app.post('/api/tally/connect', async (req, res) => {
    const { host, port } = req.body;
    if (host) setSetting('tally_host', host);
    if (port) setSetting('tally_port', String(port));
    const tally = new TallyConnector({ host: host || getSetting('tally_host'), port: port || parseInt(getSetting('tally_port')) });
    const health = await tally.healthCheck();
    res.json(health);
});

app.get('/api/tally/companies', async (req, res) => {
    try {
        const host = getSetting('tally_host') || 'localhost';
        const port = parseInt(getSetting('tally_port') || '9000');
        const tally = new TallyConnector({ host, port });
        const companies = await tally.getCompanies();
        res.json({ companies });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== SYNC MANAGEMENT =====

app.post('/api/sync/start', async (req, res) => {
    if (syncInProgress) return res.status(409).json({ error: 'Sync already in progress' });

    const { companyName, fromDate, toDate, forceResync } = req.body;
    if (!companyName || !fromDate || !toDate) {
        return res.status(400).json({ error: 'companyName, fromDate, toDate required' });
    }

    db.prepare('INSERT OR IGNORE INTO companies (name) VALUES (?)').run(companyName);
    const company = db.prepare('SELECT * FROM companies WHERE name = ?').get(companyName);

    syncInProgress = true;
    syncProgress = { step: 'init', status: 'running', message: 'Starting...' };

    const host = getSetting('tally_host') || 'localhost';
    const port = parseInt(getSetting('tally_port') || '9000');

    const extractor = new DataExtractor(db, {
        host, port,
        onProgress: (p) => { syncProgress = p; }
    });

    // Pre-flight check — fail fast if Tally is not reachable
    const alive = await extractor.tally.ping();
    if (!alive) {
        syncInProgress = false;
        return res.status(503).json({
            error: `Tally is not reachable at ${host}:${port}. Please open Tally Prime and try again.`
        });
    }

    // Read per-company sync modules (optional features)
    const syncModules = JSON.parse(company.sync_modules || '{}');

    extractor.runFullSync(company.id, companyName, fromDate, toDate, { forceResync: !!forceResync, syncModules })
        .then(results => {
            syncInProgress = false;
            syncProgress = { step: 'complete', status: 'done', results };
        })
        .catch(err => {
            syncInProgress = false;
            syncProgress = { step: 'error', status: 'error', message: err.message };
        });

    res.json({ message: 'Sync started', companyId: company.id });
});

app.get('/api/sync/progress', (req, res) => {
    res.json({ inProgress: syncInProgress, progress: syncProgress });
});

app.get('/api/sync/log', (req, res) => {
    const companyId = req.query.companyId || 1;
    const logs = db.prepare('SELECT * FROM sync_log WHERE company_id = ? ORDER BY id DESC LIMIT 100').all(companyId);
    res.json(logs);
});

// ===== DASHBOARD DATA API =====

app.get('/api/companies', (req, res) => {
    const companies = db.prepare('SELECT * FROM companies WHERE is_active = 1 ORDER BY last_full_sync_at DESC').all();
    res.json(companies);
});

// ===== KPI SUMMARY (Dynamic TB - Optimized) =====
app.get('/api/dashboard/kpi', (req, res) => {
    const { companyId, fromDate, toDate } = req.query;
    if (!companyId) return res.status(400).json({ error: 'companyId required' });

    const from = fromDate || '2024-04-01';
    const to = toDate || '2025-03-31';

    // Build in-memory lookups
    const lgMap = buildLedgerGroupMap(companyId);
    const vByLedger = getVouchersByLedger(companyId, from, to);

    // Metadata-based sets: catch ALL P&L groups including custom ones (FIX-18)
    const { directCredit, indirectCredit, directDebit, indirectDebit } = buildPLGroupSets(companyId);
    // Standard reserved groups for individual card display
    const salesSet    = new Set(getGroupTree(companyId, 'Sales Accounts'));
    const purchaseSet = new Set(getGroupTree(companyId, 'Purchase Accounts'));

    // Primary: voucher-based P&L flows (trusted, no anomalies)
    const salesFlow    = computePLFlow(vByLedger, lgMap, salesSet);
    const purchaseFlow = computePLFlow(vByLedger, lgMap, purchaseSet);
    let allDCFlow      = computePLFlow(vByLedger, lgMap, directCredit);
    let allDDFlow      = computePLFlow(vByLedger, lgMap, directDebit);
    let allICFlow      = computePLFlow(vByLedger, lgMap, indirectCredit);
    let allIDFlow      = computePLFlow(vByLedger, lgMap, indirectDebit);

    // FIX-19: Hybrid TB top-up — closes the gap between voucher-captured activity and
    // Tally's authoritative Trial Balance for every P&L ledger.
    //
    // Formula (per ledger):
    //   Debit groups  (expenses): topUp = max(0, TB_net_debit  − |voucher_credit_net|)
    //                             = max(0, (dr − cr) + voucherSum)   [voucherSum < 0 for credits]
    //   Credit groups (income):   topUp = max(0, TB_net_credit − voucher_debit_net)
    //                             = max(0, (cr − dr) − voucherSum)   [voucherSum > 0 for credits]
    //
    // Zero-voucher ledgers: voucherSum = 0 → topUp = full TB net (same as before)
    // With-voucher ledgers: topUp = gap only (prevents double-counting)
    // Dr's Consultancy etc. correctly captured by vouchers → topUp = 0 (clamped)
    const voucherMap = new Map(vByLedger.map(r => [r.ledger_name, r.total]));
    const tbSupp = getTBSupplement(companyId, from, to);
    for (const r of tbSupp) {
        if (!r.group_name) continue;
        const dr = r.net_debit  || 0;
        const cr = r.net_credit || 0;
        const vs = voucherMap.get(r.ledger_name) || 0;  // raw voucher sum (negative = net credit)
        if      (directDebit.has(r.group_name))    allDDFlow -= Math.max(0, (dr - cr) + vs);
        else if (directCredit.has(r.group_name))   allDCFlow += Math.max(0, (cr - dr) - vs);
        else if (indirectDebit.has(r.group_name))  allIDFlow -= Math.max(0, (dr - cr) + vs);
        else if (indirectCredit.has(r.group_name)) allICFlow += Math.max(0, (cr - dr) - vs);
    }

    // Gross / Net profit correct for ANY CoA structure
    const grossProfit = allDCFlow + allDDFlow;
    const netProfit   = grossProfit + allICFlow + allIDFlow;

    // Card display values (positive amounts)
    const rev            = salesFlow;                        // Sales only
    const purchaseVal    = -purchaseFlow;                    // Purchase only
    const directExpVal   = -(allDDFlow - purchaseFlow);      // All direct debit minus purchases
    const indirectExpVal = -allIDFlow;
    const indirectIncVal = allICFlow;
    const directIncVal  = allDCFlow - salesFlow;              // Direct Incomes (non-Sales direct credit)

    // BS KPIs (closing balance as of toDate)
    const sdGroups = getGroupTree(companyId, 'Sundry Debtors');
    const scGroups = getGroupTree(companyId, 'Sundry Creditors');
    const cashGroups = getGroupTree(companyId, 'Cash-in-Hand');
    const bankGroups = getGroupTree(companyId, 'Bank Accounts');
    const securedGroups = getGroupTree(companyId, 'Secured Loans');
    const unsecuredGroups = getGroupTree(companyId, 'Unsecured Loans');

    const sdDebit = computeBSClosing(companyId, to, sdGroups, 'debit', lgMap);
    const scDebit = computeBSClosing(companyId, to, scGroups, 'debit', lgMap);
    const receivables = -(sdDebit + scDebit);

    const sdCredit = computeBSClosing(companyId, to, sdGroups, 'credit', lgMap);
    const scCredit = computeBSClosing(companyId, to, scGroups, 'credit', lgMap);
    const payables = sdCredit + scCredit;

    const cashBal = computeBSClosing(companyId, to, cashGroups, null, lgMap);
    const bankBal = computeBSClosing(companyId, to, bankGroups, null, lgMap);
    const cashBankBalance = -(cashBal + bankBal);

    const securedBal = computeBSClosing(companyId, to, securedGroups, null, lgMap);
    const unsecuredBal = computeBSClosing(companyId, to, unsecuredGroups, null, lgMap);
    const loans = securedBal + unsecuredBal;

    res.json({
        revenue: rev,
        directIncome: directIncVal,
        purchase: purchaseVal,
        directExpenses: directExpVal,
        indirectExpenses: indirectExpVal,
        indirectIncome: indirectIncVal,
        grossProfit,
        netProfit,
        receivables,
        payables,
        cashBankBalance,
        loans,
        period: { from, to }
    });
});

// ===== MONTHLY TREND (Optimized) =====
app.get('/api/dashboard/monthly-trend', (req, res) => {
    const { companyId, fromDate, toDate } = req.query;
    if (!companyId) return res.status(400).json({ error: 'companyId required' });

    const from = fromDate || '2024-04-01';
    const to = toDate || '2025-03-31';

    const { directCredit, indirectCredit, directDebit, indirectDebit } = buildPLGroupSets(companyId);

    // FIX-23: Use TB data for monthly trend (authoritative).
    // Purchase vouchers lack AllLedgerEntries in bare Collection API, so
    // voucher-based monthly trend missed ~5.7Cr of Purchases.
    // Monthly TB records have correct per-ledger amounts for all P&L groups.
    const tbRows = db.prepare(`
        SELECT period_from as month, group_name,
               SUM(net_debit) as net_debit, SUM(net_credit) as net_credit
        FROM trial_balance t
        WHERE company_id = ?
          AND period_from >= ? AND period_to <= ?
          AND group_name IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM trial_balance t2
              WHERE t2.company_id = t.company_id
                AND t2.ledger_name = t.ledger_name
                AND t2.period_from = t.period_from
                AND t2.period_to < t.period_to
          )
        GROUP BY period_from, group_name
    `).all(companyId, from, to);

    const months = {};
    for (const row of tbRows) {
        const grp = row.group_name;
        if (!months[row.month]) months[row.month] = { allDC: 0, allDD: 0, allIC: 0, allID: 0 };
        const m = months[row.month];
        const dr = row.net_debit  || 0;
        const cr = row.net_credit || 0;
        // Credit groups (revenue/income): flow = cr − dr (positive = earned)
        // Debit groups (expenses): allDD -= (dr − cr) keeps allDD negative for expenses
        if (directCredit.has(grp))   m.allDC += (cr - dr);
        if (directDebit.has(grp))    m.allDD -= (dr - cr);
        if (indirectCredit.has(grp)) m.allIC += (cr - dr);
        if (indirectDebit.has(grp))  m.allID -= (dr - cr);
    }

    const result = Object.entries(months)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, d]) => {
            const grossProfit = d.allDC + d.allDD;
            const netProfit   = grossProfit + d.allIC + d.allID;
            return {
                month,
                revenue: d.allDC,                      // Revenue = all direct credit flow
                expenses: -(d.allDD + d.allID),        // total expenses as positive
                directExpenses: -d.allDD,              // direct expenses as positive
                indirectExpenses: -d.allID,            // indirect expenses as positive
                grossProfit,
                netProfit
            };
        });

    res.json(result);
});

// ===== TOP 10 EXPENSES (Optimized) =====
app.get('/api/dashboard/top-expenses', (req, res) => {
    const { companyId, fromDate, toDate } = req.query;
    const from = fromDate || '2024-04-01';
    const to = toDate || '2025-03-31';

    const lgMap = buildLedgerGroupMap(companyId);
    const vByLedger = getVouchersByLedger(companyId, from, to);
    const expSet = new Set([
        ...getGroupTree(companyId, 'Purchase Accounts'),
        ...getGroupTree(companyId, 'Direct Expenses'),
        ...getGroupTree(companyId, 'Indirect Expenses')
    ]);

    res.json(getTopLedgers(vByLedger, lgMap, expSet, 10, true));
});

// ===== TOP 10 DIRECT EXPENSES (by group, Tally-style) =====
app.get('/api/dashboard/top-direct-expenses', (req, res) => {
    const { companyId, fromDate, toDate } = req.query;
    const from = fromDate || '2024-04-01';
    const to = toDate || '2025-03-31';

    const lgMap = buildLedgerGroupMap(companyId);
    const vByLedger = getVouchersByLedger(companyId, from, to);
    const { directDebit } = buildPLGroupSets(companyId);

    const grouped = getTotalsByGroup(vByLedger, lgMap, directDebit, true);
    res.json(grouped.slice(0, 10));
});

// ===== TOP 10 INDIRECT EXPENSES (by group, Tally-style) =====
app.get('/api/dashboard/top-indirect-expenses', (req, res) => {
    const { companyId, fromDate, toDate } = req.query;
    const from = fromDate || '2024-04-01';
    const to = toDate || '2025-03-31';

    const lgMap = buildLedgerGroupMap(companyId);
    const vByLedger = getVouchersByLedger(companyId, from, to);
    const { indirectDebit } = buildPLGroupSets(companyId);

    const grouped = getTotalsByGroup(vByLedger, lgMap, indirectDebit, true);
    res.json(grouped.slice(0, 10));
});

// ===== TOP 10 REVENUE (Optimized) =====
app.get('/api/dashboard/top-revenue', (req, res) => {
    const { companyId, fromDate, toDate } = req.query;
    const from = fromDate || '2024-04-01';
    const to = toDate || '2025-03-31';

    const lgMap = buildLedgerGroupMap(companyId);
    const vByLedger = getVouchersByLedger(companyId, from, to);
    const { directCredit } = buildPLGroupSets(companyId);  // Sales + Direct Income

    res.json(getTopLedgers(vByLedger, lgMap, directCredit, 10, false));
});

// ===== EXPENSE CATEGORIES (Optimized) =====
app.get('/api/dashboard/expense-categories', (req, res) => {
    const { companyId, fromDate, toDate } = req.query;
    const from = fromDate || '2024-04-01';
    const to = toDate || '2025-03-31';

    const lgMap = buildLedgerGroupMap(companyId);
    const vByLedger = getVouchersByLedger(companyId, from, to);
    const expSet = new Set([
        ...getGroupTree(companyId, 'Purchase Accounts'),
        ...getGroupTree(companyId, 'Direct Expenses'),
        ...getGroupTree(companyId, 'Indirect Expenses')
    ]);

    res.json(getTotalsByGroup(vByLedger, lgMap, expSet, true));
});

// ===== REVENUE CATEGORIES (Optimized) =====
app.get('/api/dashboard/revenue-categories', (req, res) => {
    const { companyId, fromDate, toDate } = req.query;
    const from = fromDate || '2024-04-01';
    const to = toDate || '2025-03-31';

    const lgMap = buildLedgerGroupMap(companyId);
    const vByLedger = getVouchersByLedger(companyId, from, to);
    const salesSet = new Set(getGroupTree(companyId, 'Sales Accounts'));

    res.json(getTotalsByGroup(vByLedger, lgMap, salesSet, false));
});

// ===== LEDGER BREAKDOWN (drill-down analysis) =====
app.get('/api/dashboard/ledger-breakdown', (req, res) => {
    const { companyId, fromDate, toDate, groupRoot, mode, classType } = req.query;
    if (!companyId || (!groupRoot && !classType)) return res.status(400).json({ error: 'companyId and groupRoot or classType required' });

    const from = fromDate || '2024-04-01';
    const to   = toDate   || '2025-03-31';

    const lgMap = buildLedgerGroupMap(companyId);

    // classType uses metadata-based sets (catches custom groups); groupRoot uses tree walk (for BS items)
    let groupSet;
    if (classType) {
        const { directCredit, indirectCredit, directDebit, indirectDebit } = buildPLGroupSets(companyId);
        const salesGroupSet    = new Set(getGroupTree(companyId, 'Sales Accounts'));
        const purchaseGroupSet = new Set(getGroupTree(companyId, 'Purchase Accounts'));
        const directExpOnly = new Set(directDebit); purchaseGroupSet.forEach(g => directExpOnly.delete(g));
        const directIncOnly = new Set(directCredit); salesGroupSet.forEach(g => directIncOnly.delete(g));
        const classMap = {
            revenue:     salesGroupSet,
            purchase:    purchaseGroupSet,
            directexp:   directExpOnly,
            indirectexp: indirectDebit,
            directinc:   directIncOnly,
            indirectinc: indirectCredit,
        };
        groupSet = classMap[classType] || new Set();
    } else {
        const roots = groupRoot.split(',');
        groupSet = new Set(roots.flatMap(r => getGroupTree(companyId, r.trim())));
    }

    if (mode === 'balance') {
        // Balance sheet items — use trial_balance closing_balance for latest available month in range
        const latestTB = db.prepare(
            `SELECT DISTINCT period_from FROM trial_balance WHERE company_id = ? AND period_from <= ? ORDER BY period_from DESC LIMIT 1`
        ).get(companyId, to);
        if (!latestTB) return res.json([]);
        const rows = db.prepare(
            `SELECT ledger_name, group_name, closing_balance FROM trial_balance WHERE company_id = ? AND period_from = ?`
        ).all(companyId, latestTB.period_from);
        const result = rows
            .filter(r => groupSet.has(r.group_name) && r.closing_balance !== 0)
            .map(r => ({ ledger_name: r.ledger_name, group_name: r.group_name, amount: Math.abs(r.closing_balance) }))
            .sort((a, b) => b.amount - a.amount);
        return res.json(result);
    }

    // P&L flow: use TB directly for authoritative per-ledger amounts (FIX-19).
    // TB captures all entries including those Tally's Voucher Collection API omits.
    // April anomaly is handled inside getTBSupplement (April = full-year for affected companies).
    const tbSupp = getTBSupplement(companyId, from, to);
    const result = [];
    for (const r of tbSupp) {
        if (!r.group_name || !groupSet.has(r.group_name)) continue;
        const amount = Math.abs((r.net_debit || 0) - (r.net_credit || 0));
        if (amount > 0) result.push({ ledger_name: r.ledger_name, group_name: r.group_name, amount });
    }
    result.sort((a, b) => b.amount - a.amount);
    res.json(result);
});

// ===== GROUP BREAKDOWN (Tally-style hierarchical drill-down) =====
app.get('/api/dashboard/group-breakdown', (req, res) => {
    const { companyId, fromDate, toDate, groupRoot, mode, classType, parentGroup } = req.query;
    if (!companyId || (!groupRoot && !classType)) return res.status(400).json({ error: 'companyId and groupRoot or classType required' });

    const from = fromDate || '2024-04-01';
    const to   = toDate   || '2025-03-31';

    // 1. Resolve groupSet (same logic as ledger-breakdown)
    let groupSet;
    if (classType) {
        const { directCredit, indirectCredit, directDebit, indirectDebit } = buildPLGroupSets(companyId);
        const salesGroupSet    = new Set(getGroupTree(companyId, 'Sales Accounts'));
        const purchaseGroupSet = new Set(getGroupTree(companyId, 'Purchase Accounts'));
        const directExpOnly = new Set(directDebit); purchaseGroupSet.forEach(g => directExpOnly.delete(g));
        const directIncOnly = new Set(directCredit); salesGroupSet.forEach(g => directIncOnly.delete(g));
        const classMap = {
            revenue:     salesGroupSet,
            purchase:    purchaseGroupSet,
            directexp:   directExpOnly,
            indirectexp: indirectDebit,
            directinc:   directIncOnly,
            indirectinc: indirectCredit,
        };
        groupSet = classMap[classType] || new Set();
    } else {
        const roots = groupRoot.split(',');
        groupSet = new Set(roots.flatMap(r => getGroupTree(companyId, r.trim())));
    }

    // 2. Get all ledger amounts
    let ledgerRows = [];
    if (mode === 'balance') {
        const latestTB = db.prepare(
            `SELECT DISTINCT period_from FROM trial_balance WHERE company_id = ? AND period_from <= ? ORDER BY period_from DESC LIMIT 1`
        ).get(companyId, to);
        if (!latestTB) return res.json({ parentGroup: parentGroup || null, children: [] });
        const rows = db.prepare(
            `SELECT ledger_name, group_name, closing_balance FROM trial_balance WHERE company_id = ? AND period_from = ?`
        ).all(companyId, latestTB.period_from);
        ledgerRows = rows
            .filter(r => groupSet.has(r.group_name) && r.closing_balance !== 0)
            .map(r => ({ ledger_name: r.ledger_name, group_name: r.group_name, amount: Math.abs(r.closing_balance) }));
    } else {
        const tbSupp = getTBSupplement(companyId, from, to);
        for (const r of tbSupp) {
            if (!r.group_name || !groupSet.has(r.group_name)) continue;
            const amount = Math.abs((r.net_debit || 0) - (r.net_credit || 0));
            if (amount > 0) ledgerRows.push({ ledger_name: r.ledger_name, group_name: r.group_name, amount });
        }
    }

    // 3. Fetch group hierarchy and build maps
    const allGroups = db.prepare('SELECT group_name, parent_group FROM account_groups WHERE company_id = ?').all(companyId);
    const parentMap = {};   // group_name → parent_group
    const childrenMap = {}; // parent → [child group names]
    allGroups.forEach(g => {
        parentMap[g.group_name] = g.parent_group;
        if (!childrenMap[g.parent_group]) childrenMap[g.parent_group] = [];
        childrenMap[g.parent_group].push(g.group_name);
    });

    // Group ledgers by their immediate parent group
    const ledgersByGroup = {};
    ledgerRows.forEach(l => {
        if (!ledgersByGroup[l.group_name]) ledgersByGroup[l.group_name] = [];
        ledgersByGroup[l.group_name].push(l);
    });

    // 4. Recursive sum of all descendant ledger amounts within groupSet
    const sumCache = {};
    function sumDescendants(groupName) {
        if (sumCache[groupName] !== undefined) return sumCache[groupName];
        let total = (ledgersByGroup[groupName] || []).reduce((s, l) => s + l.amount, 0);
        (childrenMap[groupName] || []).forEach(child => {
            if (groupSet.has(child)) total += sumDescendants(child);
        });
        sumCache[groupName] = total;
        return total;
    }

    // 5. Determine target parent
    let targetParent;
    if (parentGroup) {
        targetParent = parentGroup;
    } else {
        // Find root(s): groups in groupSet whose parent is NOT in groupSet
        const roots = [...groupSet].filter(g => !groupSet.has(parentMap[g]));
        if (roots.length === 1) {
            targetParent = roots[0];
        } else {
            // Multiple roots — show them as top-level items
            const children = roots
                .map(r => ({ type: 'group', name: r, amount: sumDescendants(r) }))
                .filter(c => c.amount > 0)
                .sort((a, b) => b.amount - a.amount);
            return res.json({ parentGroup: null, children });
        }
    }

    // 6. Build children list for targetParent
    const children = [];

    // Child groups (sub-groups within groupSet)
    (childrenMap[targetParent] || []).forEach(childGroup => {
        if (!groupSet.has(childGroup)) return;
        const amount = sumDescendants(childGroup);
        if (amount > 0) children.push({ type: 'group', name: childGroup, amount });
    });

    // Direct ledgers under this group
    (ledgersByGroup[targetParent] || []).forEach(l => {
        children.push({ type: 'ledger', name: l.ledger_name, amount: l.amount });
    });

    children.sort((a, b) => b.amount - a.amount);
    res.json({ parentGroup: targetParent, children });
});

// ===== ITEM MONTHLY TREND (per-group or per-ledger YTD trend) =====
app.get('/api/dashboard/item-monthly-trend', (req, res) => {
    const { companyId, fromDate, toDate, groupRoot, mode, classType, parentGroup, ledgerName } = req.query;
    if (!companyId || (!groupRoot && !classType)) return res.status(400).json({ error: 'companyId and groupRoot or classType required' });

    const from = fromDate || '2024-04-01';
    const to   = toDate   || '2025-03-31';

    // 1. Resolve groupSet (same logic as group-breakdown)
    let groupSet;
    if (classType) {
        const { directCredit, indirectCredit, directDebit, indirectDebit } = buildPLGroupSets(companyId);
        const salesGroupSet    = new Set(getGroupTree(companyId, 'Sales Accounts'));
        const purchaseGroupSet = new Set(getGroupTree(companyId, 'Purchase Accounts'));
        const directExpOnly = new Set(directDebit); purchaseGroupSet.forEach(g => directExpOnly.delete(g));
        const directIncOnly = new Set(directCredit); salesGroupSet.forEach(g => directIncOnly.delete(g));
        const classMap = {
            revenue: salesGroupSet, purchase: purchaseGroupSet,
            directexp: directExpOnly, indirectexp: indirectDebit,
            directinc: directIncOnly, indirectinc: indirectCredit,
        };
        groupSet = classMap[classType] || new Set();
    } else {
        const roots = groupRoot.split(',');
        groupSet = new Set(roots.flatMap(r => getGroupTree(companyId, r.trim())));
    }

    // 2. If parentGroup specified, narrow groupSet to descendants of that group
    if (parentGroup) {
        const descendants = new Set(getGroupTree(companyId, parentGroup));
        const narrowed = new Set();
        descendants.forEach(g => { if (groupSet.has(g)) narrowed.add(g); });
        groupSet = narrowed;
    }

    const lgMap = buildLedgerGroupMap(companyId);

    // 3. Get monthly data and aggregate
    if (mode === 'balance') {
        // For balance-sheet items, use monthly TB records
        const tbRows = db.prepare(
            `SELECT period_from as month, ledger_name, group_name, closing_balance
             FROM trial_balance WHERE company_id = ? AND period_from >= ? AND period_from <= ?
             ORDER BY period_from`
        ).all(companyId, from, to);

        const months = {};
        for (const r of tbRows) {
            if (!r.group_name || !groupSet.has(r.group_name)) continue;
            if (ledgerName && r.ledger_name !== ledgerName) continue;
            if (!months[r.month]) months[r.month] = 0;
            months[r.month] += Math.abs(r.closing_balance || 0);
        }

        const result = Object.entries(months)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([month, amount]) => ({ month, amount }));
        return res.json(result);
    }

    // P&L items: use vouchers
    const monthlyRows = getMonthlyVouchers(companyId, from, to);
    const months = {};
    for (const row of monthlyRows) {
        if (ledgerName) {
            // Single ledger filter
            if (row.ledger_name !== ledgerName) continue;
            const grp = lgMap[row.ledger_name];
            if (!grp || !groupSet.has(grp)) continue;
        } else {
            const grp = lgMap[row.ledger_name];
            if (!grp || !groupSet.has(grp)) continue;
        }
        if (!months[row.month]) months[row.month] = 0;
        months[row.month] += Math.abs(row.total);
    }

    const result = Object.entries(months)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, amount]) => ({ month, amount }));
    res.json(result);
});

// ===== RECEIVABLE AGEING =====
app.get('/api/dashboard/receivable-ageing', (req, res) => {
    const { companyId } = req.query;
    const rows = db.prepare(`
        SELECT party_name,
            SUM(CASE WHEN overdue_days <= 30 THEN ABS(outstanding_amount) ELSE 0 END) as "0_30",
            SUM(CASE WHEN overdue_days > 30 AND overdue_days <= 60 THEN ABS(outstanding_amount) ELSE 0 END) as "31_60",
            SUM(CASE WHEN overdue_days > 60 AND overdue_days <= 90 THEN ABS(outstanding_amount) ELSE 0 END) as "61_90",
            SUM(CASE WHEN overdue_days > 90 THEN ABS(outstanding_amount) ELSE 0 END) as "90_plus",
            SUM(ABS(outstanding_amount)) as total
        FROM bills_outstanding WHERE company_id = ? AND nature = 'receivable'
        GROUP BY party_name ORDER BY total DESC LIMIT 15
    `).all(companyId);
    res.json(rows);
});

// ===== PAYABLE AGEING =====
app.get('/api/dashboard/payable-ageing', (req, res) => {
    const { companyId } = req.query;
    const rows = db.prepare(`
        SELECT party_name,
            SUM(CASE WHEN overdue_days <= 30 THEN ABS(outstanding_amount) ELSE 0 END) as "0_30",
            SUM(CASE WHEN overdue_days > 30 AND overdue_days <= 60 THEN ABS(outstanding_amount) ELSE 0 END) as "31_60",
            SUM(CASE WHEN overdue_days > 60 AND overdue_days <= 90 THEN ABS(outstanding_amount) ELSE 0 END) as "61_90",
            SUM(CASE WHEN overdue_days > 90 THEN ABS(outstanding_amount) ELSE 0 END) as "90_plus",
            SUM(ABS(outstanding_amount)) as total
        FROM bills_outstanding WHERE company_id = ? AND nature = 'payable'
        GROUP BY party_name ORDER BY total DESC LIMIT 15
    `).all(companyId);
    res.json(rows);
});

// ===== STOCK SUMMARY =====
app.get('/api/dashboard/stock-summary', (req, res) => {
    const { companyId } = req.query;
    const rows = db.prepare(`
        SELECT item_name, stock_group, closing_qty, closing_value
        FROM stock_summary WHERE company_id = ? AND period_to = (SELECT MAX(period_to) FROM stock_summary WHERE company_id = ?)
        ORDER BY closing_value DESC LIMIT 20
    `).all(companyId, companyId);
    res.json(rows);
});

// ===== TRIAL BALANCE =====
app.get('/api/dashboard/trial-balance', (req, res) => {
    const { companyId, fromDate, toDate } = req.query;
    const rows = db.prepare(`
        SELECT ledger_name, group_name, SUM(opening_balance) as opening, SUM(net_debit) as debit, SUM(net_credit) as credit, SUM(closing_balance) as closing
        FROM trial_balance WHERE company_id = ? AND period_from <= ? AND period_to >= ?
        GROUP BY ledger_name, group_name ORDER BY ABS(SUM(closing_balance)) DESC
    `).all(companyId, toDate || '2025-03-31', fromDate || '2024-04-01');
    res.json(rows);
});

// ===== SETTINGS =====

app.get('/api/settings', (req, res) => {
    const settings = db.prepare('SELECT key, value FROM app_settings').all();
    const obj = {};
    settings.forEach(s => obj[s.key] = s.value);
    res.json(obj);
});

app.post('/api/settings', (req, res) => {
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
        setSetting(key, String(value));
    }
    res.json({ success: true });
});

// ===== OPTIONAL MODULE MANAGEMENT =====

app.get('/api/companies/:id/modules', (req, res) => {
    const company = db.prepare('SELECT sync_modules FROM companies WHERE id = ?').get(req.params.id);
    if (!company) return res.status(404).json({ error: 'Company not found' });
    res.json(JSON.parse(company.sync_modules || '{}'));
});

app.post('/api/companies/:id/modules', (req, res) => {
    const company = db.prepare('SELECT id FROM companies WHERE id = ?').get(req.params.id);
    if (!company) return res.status(404).json({ error: 'Company not found' });
    db.prepare('UPDATE companies SET sync_modules = ? WHERE id = ?').run(JSON.stringify(req.body), req.params.id);
    res.json({ success: true });
});

// ===== OPTIONAL MODULE REPORTS =====

app.get('/api/dashboard/gst-summary', (req, res) => {
    const { companyId, fromDate, toDate } = req.query;
    if (!companyId) return res.status(400).json({ error: 'companyId required' });
    const from = fromDate || '2024-04-01';
    const to = toDate || '2025-03-31';

    const rows = db.prepare(`
        SELECT voucher_type, COUNT(*) as count, SUM(taxable_value) as taxable,
               SUM(igst) as igst, SUM(cgst) as cgst, SUM(sgst) as sgst, SUM(cess) as cess
        FROM gst_entries
        WHERE company_id = ? AND date >= ? AND date <= ?
        GROUP BY voucher_type
        ORDER BY taxable DESC
    `).all(companyId, from, to);

    const monthly = db.prepare(`
        SELECT substr(date,1,7) as month, SUM(taxable_value) as taxable,
               SUM(igst+cgst+sgst+cess) as total_tax, COUNT(*) as count
        FROM gst_entries
        WHERE company_id = ? AND date >= ? AND date <= ?
        GROUP BY month ORDER BY month
    `).all(companyId, from, to);

    res.json({ byType: rows, monthly });
});

app.get('/api/dashboard/cost-centre-analysis', (req, res) => {
    const { companyId, fromDate, toDate } = req.query;
    if (!companyId) return res.status(400).json({ error: 'companyId required' });
    const from = fromDate || '2024-04-01';
    const to = toDate || '2025-03-31';

    // Cost centre vs expense ledgers (amounts where cost centre allocation exists)
    const byCentre = db.prepare(`
        SELECT cost_centre, SUM(ABS(amount)) as total_amount, COUNT(DISTINCT ledger_name) as ledger_count
        FROM cost_allocations
        WHERE company_id = ? AND date >= ? AND date <= ?
        GROUP BY cost_centre ORDER BY total_amount DESC
    `).all(companyId, from, to);

    const centres = db.prepare('SELECT name, parent, category FROM cost_centres WHERE company_id = ?').all(companyId);

    res.json({ byCentre, centres });
});

app.get('/api/dashboard/payroll-summary', (req, res) => {
    const { companyId, fromDate, toDate } = req.query;
    if (!companyId) return res.status(400).json({ error: 'companyId required' });
    const from = fromDate || '2024-04-01';
    const to = toDate || '2025-03-31';

    const byEmployee = db.prepare(`
        SELECT employee_name, SUM(ABS(amount)) as total, COUNT(DISTINCT date) as payslips
        FROM payroll_entries
        WHERE company_id = ? AND date >= ? AND date <= ? AND employee_name != ''
        GROUP BY employee_name ORDER BY total DESC LIMIT 50
    `).all(companyId, from, to);

    const byPayHead = db.prepare(`
        SELECT pay_head, SUM(ABS(amount)) as total
        FROM payroll_entries
        WHERE company_id = ? AND date >= ? AND date <= ? AND pay_head != ''
        GROUP BY pay_head ORDER BY total DESC
    `).all(companyId, from, to);

    const monthly = db.prepare(`
        SELECT substr(date,1,7) as month, SUM(ABS(amount)) as total
        FROM payroll_entries
        WHERE company_id = ? AND date >= ? AND date <= ?
        GROUP BY month ORDER BY month
    `).all(companyId, from, to);

    res.json({ byEmployee, byPayHead, monthly });
});

// On-demand stock item ledger extraction + retrieval
app.post('/api/sync/stock-item-ledger', async (req, res) => {
    const { companyId, companyName, itemName, fromDate, toDate } = req.body;
    if (!companyId || !itemName || !fromDate || !toDate) {
        return res.status(400).json({ error: 'companyId, itemName, fromDate, toDate required' });
    }
    const host = getSetting('tally_host') || 'localhost';
    const port = parseInt(getSetting('tally_port') || '9000');
    const extractor = new DataExtractor(db, { host, port });
    try {
        const count = await extractor.extractStockItemLedger(companyId, companyName, itemName, fromDate, toDate);
        res.json({ success: true, rowCount: count });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/dashboard/stock-item-ledger', (req, res) => {
    const { companyId, itemName, fromDate, toDate } = req.query;
    if (!companyId || !itemName) return res.status(400).json({ error: 'companyId and itemName required' });
    const from = fromDate || '2024-04-01';
    const to = toDate || '2025-03-31';

    const rows = db.prepare(`
        SELECT date, voucher_type, voucher_number, party_name, quantity, amount
        FROM stock_item_ledger
        WHERE company_id = ? AND item_name = ? AND date >= ? AND date <= ?
        ORDER BY date
    `).all(companyId, itemName, from, to);

    // Running balance
    let runningQty = 0;
    const enriched = rows.map(r => {
        runningQty += r.quantity;
        return { ...r, running_qty: runningQty };
    });

    res.json(enriched);
});

// ===== START SERVER =====
const PORT = parseInt(getSetting('dashboard_port') || process.env.PORT || '3456');
app.listen(PORT, () => {
    console.log(`\n  TallyVision API Server (v4 - Optimized Dynamic TB)`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  Database: ${getDbPath()}\n`);
});

module.exports = app;