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

    extractor.runFullSync(company.id, companyName, fromDate, toDate, { forceResync: !!forceResync })
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

    // Build in-memory lookup (once, ~8ms)
    const lgMap = buildLedgerGroupMap(companyId);

    // Get all voucher totals by ledger (once, ~15ms, no JOIN)
    const vByLedger = getVouchersByLedger(companyId, from, to);

    // Build group sets
    const salesSet = new Set(getGroupTree(companyId, 'Sales Accounts'));
    const purchaseSet = new Set(getGroupTree(companyId, 'Purchase Accounts'));
    const directExpSet = new Set(getGroupTree(companyId, 'Direct Expenses'));
    const indirectExpSet = new Set(getGroupTree(companyId, 'Indirect Expenses'));
    const directIncSet = new Set(getGroupTree(companyId, 'Direct Incomes'));
    const indirectIncSet = new Set(getGroupTree(companyId, 'Indirect Incomes'));

    // P&L KPIs (in-memory filter, <1ms each)
    const rev = computePLFlow(vByLedger, lgMap, salesSet);
    const purchaseVal = -computePLFlow(vByLedger, lgMap, purchaseSet);
    const directExpVal = -computePLFlow(vByLedger, lgMap, directExpSet);
    const indirectExpVal = -computePLFlow(vByLedger, lgMap, indirectExpSet);
    const directIncVal = computePLFlow(vByLedger, lgMap, directIncSet);
    const indirectIncVal = computePLFlow(vByLedger, lgMap, indirectIncSet);

    const grossProfit = rev + directIncVal - purchaseVal - directExpVal;
    const netProfit = grossProfit + indirectIncVal - indirectExpVal;

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
        purchase: purchaseVal,
        directExpenses: directExpVal,
        indirectExpenses: indirectExpVal,
        grossProfit,
        netProfit,
        indirectIncome: indirectIncVal,
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

    const lgMap = buildLedgerGroupMap(companyId);
    const salesSet = new Set(getGroupTree(companyId, 'Sales Accounts'));
    const expSet = new Set([
        ...getGroupTree(companyId, 'Purchase Accounts'),
        ...getGroupTree(companyId, 'Direct Expenses'),
        ...getGroupTree(companyId, 'Indirect Expenses')
    ]);

    const monthlyRows = getMonthlyVouchers(companyId, from, to);

    // Aggregate by month in JS
    const months = {};
    for (const row of monthlyRows) {
        const grp = lgMap[row.ledger_name];
        if (!grp) continue;
        if (!months[row.month]) months[row.month] = { revenue: 0, expenses: 0 };
        if (salesSet.has(grp)) months[row.month].revenue += row.total;
        if (expSet.has(grp)) months[row.month].expenses += -row.total;
    }

    const result = Object.entries(months)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, d]) => ({
            month,
            revenue: d.revenue,
            expenses: d.expenses,
            profit: d.revenue - d.expenses
        }));

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

// ===== TOP 10 REVENUE (Optimized) =====
app.get('/api/dashboard/top-revenue', (req, res) => {
    const { companyId, fromDate, toDate } = req.query;
    const from = fromDate || '2024-04-01';
    const to = toDate || '2025-03-31';

    const lgMap = buildLedgerGroupMap(companyId);
    const vByLedger = getVouchersByLedger(companyId, from, to);
    const salesSet = new Set(getGroupTree(companyId, 'Sales Accounts'));

    res.json(getTopLedgers(vByLedger, lgMap, salesSet, 10, false));
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

// ===== START SERVER =====
const PORT = parseInt(getSetting('dashboard_port') || process.env.PORT || '3456');
app.listen(PORT, () => {
    console.log(`\n  TallyVision API Server (v4 - Optimized Dynamic TB)`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  Database: ${getDbPath()}\n`);
});

module.exports = app;