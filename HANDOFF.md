# TallyVision — Developer Handoff Document

**Version:** 2.1.0 (v2.1.0 — FIX-23)
**Date:** March 2026
**Repo:** https://github.com/Laaxxmm/Tally_Vision
**Stack:** Node.js + Express, better-sqlite3, Chart.js, Tailwind CSS
**Dashboard:** http://localhost:3456
**Tally Port:** 9000 (default)

---

## 1. How It Works (End-to-End Flow)

```
User clicks "Sync" in dashboard
    |
    v
POST /api/sync/start { companyName, fromDate, toDate, forceResync }
    |
    v
DataExtractor.runFullSync()
    |-- extractChartOfAccounts()      1 request   → account_groups table
    |-- extractLedgers()              1 request   → ledgers table
    |-- extractTrialBalance()         12 requests → trial_balance table (monthly)
    |-- extractVouchers()             12 requests → vouchers table (monthly, bare API)
    |-- extractStockSummary()         4 requests  → stock_summary table (quarterly)
    |-- extractBillsOutstanding()     2 requests  → bills_outstanding table (recv + pay)
    |-- [optional] extractGstEntries()
    |-- [optional] extractCostAllocations()
    |-- [optional] extractPayroll()
    |
    v
SQLite DB populated → REST API serves computed KPIs/charts → Dashboard renders
```

**Total Tally requests per full sync:** ~32 (+ optional modules)

---

## 2. File-by-File Guide

### `src/backend/server.js` (~1,117 lines)
The Express REST API and the **Dynamic TB Engine**.

**Core engine functions (top of file):**
- `buildLedgerGroupMap(companyId)` — Creates `Map<ledger_name, group_name>` from trial_balance. ~8ms. Used by all KPI and drill-down endpoints.
- `buildPLGroupSets(companyId)` — Classifies all P&L groups into 4 sets using account_groups metadata:
  - `directCredit` (PL + Credit + AffectsGrossProfit) = Sales, Direct Incomes
  - `directDebit` (PL + Debit + AffectsGrossProfit) = Purchases, Direct Expenses
  - `indirectCredit` (PL + Credit + !AffectsGrossProfit) = Indirect Incomes
  - `indirectDebit` (PL + Debit + !AffectsGrossProfit) = Indirect Expenses
- `getGroupTree(companyId, parentName)` — Recursive walker returning all descendant group names
- `getTBSupplement(companyId, from, to)` — Monthly TB query with dedup (shortest period_to per period_from)
- `computePLFlow(vouchersByLedger, lgMap, groupSet)` — Sums voucher amounts for ledgers matching a group set
- `computeBSClosing(companyId, asOfDate, groupNames, balanceFilter, lgMap)` — TB opening + voucher movements for BS items
- `getMonthlyVouchers(companyId, from, to)` — Aggregates voucher amounts by month+ledger

**KPI endpoint (`/api/dashboard/kpi`):**
Uses a **hybrid TB + voucher** approach:
1. Sum voucher flows per P&L group set
2. Get TB supplement (monthly totals)
3. For each TB row, compute `Math.max(0, tbAmount + voucherSum)` — the clamp prevents double-counting
4. Sum debit/credit groups separately for GP and NP

**Monthly trend endpoint (`/api/dashboard/monthly-trend`):**
Uses **TB data only** (not vouchers). Reason: Purchase vouchers lack `AllLedgerEntries` expansion in Tally's Collection API, so voucher-based Purchase amounts map to party names (BS groups) instead of P&L groups. TB is authoritative.

**Group breakdown endpoint (`/api/dashboard/group-breakdown`):**
Supports two modes:
- `classType` param (revenue, directexp, indirectexp, indirectinc) — P&L drill-down
- `groupRoot` param (Cash-in-Hand, Bank Accounts, etc.) — BS drill-down

Returns `{ children: [{ name, type: 'group'|'ledger', amount }] }` for hierarchical navigation.

### `src/backend/tally-connector.js`
TCP/XML communication with Tally.

- `ping()` — TCP socket check (fast, doesn't send XML)
- `sendXML(xml)` — Sends UTF-16LE encoded XML, receives and parses response
- `getCompanies()` — Fetches open companies from Tally

**Critical:** All requests/responses must be UTF-16LE encoded. Tally ignores or corrupts UTF-8.

### `src/backend/extractors/xml-templates.js` (~213 lines)
TDL XML templates for every Tally report.

| Template | Tally API Type | Notes |
|----------|---------------|-------|
| `list-masters` | Collection | Generic master list (Groups, Ledgers, etc.) |
| `chart-of-accounts` | Collection | Group hierarchy with bs_pl, dr_cr, affects_gross_profit |
| `trial-balance` | Data (Report) | Respects date ranges, monthly chunks |
| `profit-loss` | Data (Report) | Kept for compat, not used in sync |
| `balance-sheet` | Data (Report) | Kept for compat, not used in sync |
| `daybook` | Collection | **Bare API** — no filters, no AllLedgerEntries in NATIVEMETHOD |
| `stock-summary` | Collection | Quarterly chunks |
| `cost-centres` | Collection | Optional module |
| `cost-allocations` | Collection | WALK=CostCentreDetails |
| `bills-outstanding` | Collection | WALK=BillAllocations with $$Age for overdue days |
| `stock-item-ledger` | Collection | On-demand, single stock item |

### `src/backend/extractors/data-extractor.js` (~730 lines)
Chunked extraction engine.

**Key methods:**
- `fetchReport(xml)` — Parses standard Tally report XML
- `fetchVoucherCollection(xml)` — Parses voucher collection with AllLedgerEntries expansion. When no AllLedgerEntries present (Purchase vouchers), uses `partyName` as `ledgerName` fallback.
- `generateMonthChunks(from, to)` — Splits FY into 12 monthly periods
- `generateQuarterChunks(from, to)` — Splits FY into 4 quarterly periods
- `extractVouchers()` — 12 monthly requests, bare Collection API, no per-type loop
- `extractGstEntries()` — Fetches all vouchers monthly, filters GST types in JS
- `extractPayroll()` — Fetches all vouchers monthly, filters `voucherType === 'Payroll'` in JS
- `runFullSync()` — Orchestrator calling all extractors with progress callbacks

### `src/backend/db/setup.js`
SQLite schema with 14 tables and 3 migrations.

**Key tables:**
| Table | Extraction | Notes |
|-------|-----------|-------|
| `account_groups` | 1 request | CoA hierarchy with classification metadata |
| `ledgers` | 1 request | GL master list |
| `trial_balance` | 12 monthly | UNIQUE per company+period+ledger |
| `vouchers` | 12 monthly | Indexed by company+date+ledger |
| `stock_summary` | 4 quarterly | Opening/closing qty and value |
| `bills_outstanding` | 2 requests | Receivable + Payable with overdue days |

**Migrations:**
- M1: Added indexes on vouchers
- M2: Added sync_log table
- M3: Added `sync_modules` column to companies

### `src/frontend/dashboard.html` (~1,475 lines)
Single-page application. Vanilla JS, no framework.

**Layout sections:**
1. **Header** — Company selector, connection status, date range, settings button
2. **KPI Grid** — Dynamic cards generated from API response
3. **Charts Row** — 3-column: Top Revenue, Top Direct Exp, Top Indirect Exp (doughnut charts)
4. **YTD Trend** — Full-width bar chart (Revenue vs Expenses with GP/NP lines)
5. **Analysis Overlay** — Opens on KPI/chart click, shows pie + table + breadcrumb navigation
6. **Settings Modal** — Tally config, fiscal dates, company selection, module toggles, force resync
7. **Sync Progress Bar** — Hidden until sync starts, polls every 1-2s

**Chart management:**
- All charts stored in `charts = {}` object
- `destroyChart(key)` helper prevents canvas reuse errors
- Click handlers route to drill-down analysis

---

## 3. Database Schema Detail

```sql
-- Core financial data
trial_balance    UNIQUE(company_id, period_from, period_to, ledger_name)
vouchers         UNIQUE INDEX(company_id, date, voucher_type, voucher_number, ledger_name, amount)

-- Master data
account_groups   (company_id, group_name, group_parent, bs_pl, dr_cr, affects_gross_profit)
ledgers          (company_id, name, group_name)

-- Reports
stock_summary    (company_id, period_from, period_to, item_name, ...)
bills_outstanding (company_id, date, bill_date, party_name, outstanding_amount, overdue_days)

-- Optional modules
gst_entries      (company_id, date, voucher_number, party_name, igst, cgst, sgst)
cost_allocations (company_id, date, ledger_name, cost_centre, amount)
payroll_entries   (company_id, date, employee_name, pay_head, amount)

-- System
app_settings     (key, value) — tally_host, tally_port, fiscal_from, fiscal_to, etc.
sync_log         (company_id, module, status, records_count, errors)
companies        (name, sync_modules JSON)
```

**WAL mode** enabled for concurrent read/write performance.

---

## 4. P&L / KPI Formulas

```
                                          Sign in DB
Revenue (Sales Accounts)               =  credit (positive cr - dr)
Direct Incomes                         =  credit
Purchases                              =  debit  (negative, dr - cr)
Direct Expenses                        =  debit

Gross Profit  = Revenue + Direct Incomes + Purchases + Direct Expenses
              = allDCFlow + allDDFlow
              (allDD is already negative, so addition = subtraction)

Indirect Incomes                       =  credit
Indirect Expenses                      =  debit

Net Profit    = Gross Profit + Indirect Incomes + Indirect Expenses
              = GP + allICFlow + allIDFlow
```

**Group classification logic** (`buildPLGroupSets`):
- Reads `account_groups` where `bs_pl = 'PL'`
- `dr_cr = 'C'` + `affects_gross_profit = 'Y'` → directCredit
- `dr_cr = 'D'` + `affects_gross_profit = 'Y'` → directDebit
- `dr_cr = 'C'` + `affects_gross_profit = 'N'` → indirectCredit
- `dr_cr = 'D'` + `affects_gross_profit = 'N'` → indirectDebit
- Each set includes all recursive child groups via `getGroupTree()`

---

## 5. Critical Tally API Behaviors (Must Know)

### 1. Collection API ignores date ranges
`SVFROMDATE`/`SVTODATE` in `TYPE=Collection` requests are **completely ignored** by Tally. It always returns data for the currently-active UI period. Vouchers are post-filtered in JS by date.

### 2. Purchase vouchers lack AllLedgerEntries
When `AllLedgerEntries` is NOT in NATIVEMETHOD, Tally still auto-expands it for most voucher types (Sales: ~10.9 rows/voucher, Payment: ~2.1, Journal: ~2.0, Receipt: ~2.0) **BUT NOT for Purchase** (1.0 rows/voucher). Purchase vouchers return only the voucher-level Amount with PartyLedgerName.

**Impact:** Voucher-based P&L calculations miss Purchase amounts because party names map to Sundry Creditors (BS group). Solution: Use TB data for anything Purchase-dependent (monthly trend, KPI top-up).

### 3. SYSTEM Formulae can crash Tally
`NOT $IsCancelled`, `NOT $IsOptional`, `$VoucherTypeName = "X"` filters in TDL cause "Bad formula!" crash for certain Tally companies. The bare Collection API approach (no filters at all) works universally.

### 4. UTF-16LE encoding is mandatory
Both request and response must use UTF-16LE. UTF-8 requests are silently ignored or return garbled data.

### 5. Tally is single-threaded
During large XML exports, Tally's HTTP server blocks. Status pings will timeout, showing a false "Tally Offline" state during sync.

---

## 6. Version History

### v2.1.0 (FIX-23) — March 2026
- Bare Collection API for vouchers (no SYSTEM Formulae, no AllLedgerEntries in NATIVEMETHOD)
- 12 monthly requests per sync (all voucher types per request)
- TB-based monthly trend (fixes understated Purchase/Direct Expenses)
- GST/Payroll extractors: fetch-all-then-filter-in-JS pattern
- Stock-item-ledger: removed broken filter definitions

### v2.0.0 — March 2026
- Dynamic TB engine (in-memory ledger-group maps, no SQL JOINs)
- Redesigned dashboard with doughnut charts
- GP/NP analysis with drill-down
- buildPLGroupSets for automatic P&L classification
- Monthly TB chunks (FIX-20)
- Hybrid TB + voucher KPI computation (FIX-19)
- Per-company optional module toggles
- Force Resync UI

### v1.0.0 — March 2026
- Initial release
- Basic extraction engine
- Dashboard with bar/pie charts
- Trial balance, ageing, stock summary views

### Fix Log (v1.x)
| Fix | Description |
|-----|-------------|
| FIX-1 | DB moved from C: to `D:\Tally\TallyVision\data\` |
| FIX-2 | Duplicate voucher dedup + UNIQUE INDEX |
| FIX-3 | `return` inside `db.transaction` loop dropping vouchers |
| FIX-4 | Smart incremental sync (skip cached months) |
| FIX-5 | `forceResync` flag |
| FIX-6/7 | `parseNumber()` negative sign on `(1234.56)` format |
| FIX-8 | Added AllInventoryEntries (later removed in FIX-15) |
| FIX-9 | Bills Outstanding rewritten with BillAllocations WALK |
| FIX-10 | Dashboard freeze (30s Tally timeout blocking HTTP) |
| FIX-11 | Voucher sync infinite loop (NULL sync_month) |
| FIX-12 | Reverted broken date-filter experiments |
| FIX-13 | 96 Tally requests reduced to 8 (fetch-once-per-type) |
| FIX-14 | Sync timeout raised to 300s |
| FIX-15 | Removed AllInventoryEntries (20-50MB XML for pharma) |
| FIX-16 | Custom group classification via account_groups metadata |
| FIX-17 | Bills outstanding WALK=BillAllocations pattern |
| FIX-18 | buildPLGroupSets for all custom P&L groups |
| FIX-19 | Hybrid TB + voucher KPI computation |
| FIX-20 | Monthly TB chunks with force resync |
| FIX-23 | Bare Collection API, TB-based monthly trend |

---

## 7. Known Issues & Limitations

| # | Issue | Severity | Notes |
|---|-------|----------|-------|
| 1 | "Tally Offline" badge during sync | Low | Tally's HTTP server is single-threaded, can't respond to pings during sync. Suppress badge when `syncInProgress = true`. |
| 2 | Sync requires correct Tally period | Medium | User must press F2 in Tally to set correct FY. Add detection via `##SVCurrentDate`. |
| 3 | No zero-voucher warning | High | If Tally period mismatches, 0 vouchers inserted with no error. Add post-sync validation. |
| 4 | No dashboard authentication | Medium | `dashboard_password` setting exists but isn't enforced. Any LAN user can access. |
| 5 | Auto-sync not implemented | Medium | `node-cron` in dependencies, `auto_sync` setting exists, but no scheduled job. |
| 6 | License table is a stub | Low | Schema exists but no enforcement logic. |
| 7 | Purchase vouchers lack ledger detail | Info | By design (Tally API limitation). TB data used as workaround. |
| 8 | cost-allocations TDL untested | Low | Uses WALK=CostCentreDetails — field names may differ in some Tally versions. |

---

## 8. Roadmap / What to Build Next

### Priority 1 — Reliability
- [ ] Post-sync validation: warn if 0 vouchers inserted for active months
- [ ] Detect Tally's active period before sync and warn on mismatch
- [ ] Suppress "Tally Offline" badge during active sync
- [ ] Console logging for all sync steps (currently only vouchers log)

### Priority 2 — Core Features
- [ ] Auto-sync scheduler using node-cron + existing `auto_sync` setting
- [ ] Multi-FY navigation (sync and view multiple financial years)
- [ ] Export dashboard to Excel/PDF
- [ ] Dashboard password protection
- [ ] LAN access toggle (bind to 0.0.0.0 when enabled)

### Priority 3 — Analytics
- [ ] YTD trend chart in analysis overlay (plan exists, implementation pending)
- [ ] Interactive drill-down: click pie segment → show that item's monthly trend
- [ ] Party-wise ledger statement (select party → see all transactions)
- [ ] Budget vs Actual (if budget data exists in Tally)
- [ ] Multi-company comparison dashboard
- [ ] GST report (GSTR-1/3B style) from extracted data

### Priority 4 — Infrastructure
- [ ] Error boundaries in dashboard (API failures show blank tiles)
- [ ] Sync history UI (show sync_log in readable format)
- [ ] DB backup utility (one-click backup)
- [ ] Installer / setup wizard (replace install.bat)
- [ ] Tally ERP 9 edge case testing

---

## 9. Environment & Configuration

| Setting | Default | Location |
|---------|---------|----------|
| Tally host | `localhost` | `app_settings.tally_host` |
| Tally port | `9000` | `app_settings.tally_port` |
| Dashboard port | `3456` | `app_settings.dashboard_port` |
| DB path | `D:\Tally\TallyVision\data\tallyvision.db` | `setup.js` or `TALLYVISION_DATA` env var |
| Auto sync | stored but not enforced | `app_settings.auto_sync` |
| Sync interval | 60 min (stored, not enforced) | `app_settings.sync_interval_minutes` |
| LAN access | `false` | `app_settings.lan_access` |
| Password | empty (disabled) | `app_settings.dashboard_password` |

---

## 10. Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `express` | ^4.21.0 | HTTP server + REST API |
| `better-sqlite3` | ^11.0.0 | Synchronous SQLite (fast, no async overhead) |
| `fast-xml-parser` | ^5.3.5 | Parse Tally's XML responses |
| `cors` | ^2.8.5 | Cross-origin requests |
| `node-cron` | ^3.0.3 | Scheduled sync (imported but not yet used) |
| `uuid` | ^10.0.0 | Imported but not yet used |

**Frontend (CDN, no npm):** Chart.js v4, Tailwind CSS, Font Awesome

---

## 11. Development Tips

### Running locally
```bash
npm start                    # Start server on port 3456
# OR
node src/backend/server.js   # Same thing
```

### Testing extraction manually
```bash
npm run extract -- --company "Company Name" --from 2025-04-01 --to 2026-03-31
```

### Inspecting the database
```bash
# Use any SQLite viewer, or:
node -e "const db = require('better-sqlite3')('data/tallyvision.db'); console.log(db.prepare('SELECT COUNT(*) as c FROM vouchers').get())"
```

### Adding a new API endpoint
1. Add the route in `server.js` after existing similar endpoints
2. Use `buildLedgerGroupMap()` and `buildPLGroupSets()` for any P&L computation
3. Use `getTBSupplement()` for TB-based calculations
4. Return JSON with `res.json()`

### Adding a new extraction module
1. Add the XML template in `xml-templates.js`
2. Add the extraction method in `data-extractor.js`
3. Add the DB table in `setup.js` (with migration if table doesn't exist)
4. Call the new method from `runFullSync()` (conditionally, if it's an optional module)
5. Add the API endpoint in `server.js`

### Debugging Tally XML
Set a breakpoint or `console.log` in `tally-connector.js` `sendXML()` to see raw XML request/response. Tally errors typically manifest as empty responses or XML with `<LINEERROR>` tags.

---

*Document generated: March 2026 — covers v1.0.0 through v2.1.0 (FIX-1 through FIX-23)*
