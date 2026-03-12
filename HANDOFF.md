# TallyVision — Project Handoff Document
**Version:** 1.0.0 (GitHub tag: `v1`)
**Date:** March 2026
**Repo:** https://github.com/Laaxxmm/Tally_Vision
**Stack:** Node.js + Express · better-sqlite3 · Chart.js · Tailwind CSS
**Dashboard:** http://localhost:3456
**Tally Port:** 9000 (default)

---

## 1. What This Project Does

TallyVision is a **local MIS dashboard** that connects to Tally Prime / ERP 9, extracts financial data via Tally's XML-over-HTTP API, stores it in a local SQLite database, and displays it on a single-page web dashboard. No cloud, no third-party servers — everything runs on the same machine as Tally.

**What the dashboard shows:**
- KPI tiles: Revenue, Purchase, Direct Expenses, Indirect Expenses, Gross Profit, Net Profit, Receivables, Payables, Cash & Bank, Loans
- Revenue vs Expenses monthly trend chart
- Net Profit trend chart
- Top 10 Expenses (bar chart)
- Top 10 Revenue Sources (bar chart)
- Receivable Ageing (by party, bucketed 0–30 / 31–60 / 61–90 / 90+ days)
- Payable Ageing (same structure)
- Stock Summary (top items by closing value)
- Trial Balance viewer

---

## 2. Architecture

```
Tally Prime / ERP 9
  │  HTTP POST port 9000, XML request (utf-16le encoded)
  ▼
TallyConnector   ← src/backend/tally-connector.js
  │  Parses utf-16le XML response, handles timeouts + retries
  ▼
DataExtractor    ← src/backend/extractors/data-extractor.js
  │  Chunked extraction engine (month-by-month for most reports)
  │  Fetch-once-per-type for vouchers (8 Tally requests per FY sync)
  │  Smart-skip: historical cached months are never re-fetched
  ▼
SQLite DB        ← D:\Tally\TallyVision\data\tallyvision.db
  │  WAL mode, all financial data stored locally
  ▼
Express REST API ← src/backend/server.js
  │  Dynamic TB engine (in-memory ledger→group map, no SQL JOINs)
  ▼
dashboard.html   ← src/frontend/dashboard.html
     Single-page app, Chart.js + Tailwind CSS, polling-based sync progress
```

---

## 3. File Structure

```
D:\Tally\TallyVision\
├── src/
│   ├── backend/
│   │   ├── server.js                  ← Express REST API (v4 — Dynamic TB engine)
│   │   ├── tally-connector.js         ← TCP ping + XML send/receive (utf-16le)
│   │   ├── run-extraction.js          ← CLI runner for manual extraction
│   │   ├── db/
│   │   │   └── setup.js               ← SQLite schema + migrations
│   │   └── extractors/
│   │       ├── data-extractor.js      ← Core extraction engine
│   │       └── xml-templates.js       ← All TDL XML request templates
│   └── frontend/
│       └── dashboard.html             ← Single-page dashboard (SPA)
├── data/
│   └── tallyvision.db                 ← SQLite database (not in git)
├── package.json
├── install.bat
├── .gitignore
├── .claude/launch.json                ← Claude Code preview config
├── README.md
├── CHANGES.md                         ← Per-fix change log
└── HANDOFF.md                         ← This file
```

---

## 4. How to Run

```bash
# Install dependencies (first time only)
npm install

# Start the server
npm start
# → http://localhost:3456

# OR via Claude Code Preview (configured in .claude/launch.json)
# Uses autoPort: false, always binds to 3456
```

**Tally must be open** with at least one company loaded and the XML export port enabled (Gateway of Tally → F12 → Advanced Configuration → Enable ODBC server = Yes, Port = 9000).

---

## 5. SQLite Database Schema

**Location:** `D:\Tally\TallyVision\data\tallyvision.db`
**Override with env var:** `TALLYVISION_DATA=/your/path npm start`

| Table | Purpose | Key Columns |
|---|---|---|
| `app_settings` | Key-value config store | `key`, `value` |
| `license` | License management (stub for v1) | `license_key`, `max_companies`, `valid_until` |
| `companies` | One row per synced Tally company | `name`, `fy_from`, `fy_to`, `last_full_sync_at` |
| `account_groups` | Chart of Accounts hierarchy | `group_name`, `parent_group`, `bs_pl`, `dr_cr`, `affects_gross_profit` |
| `ledgers` | Ledger master list | `name`, `group_name`, `parent_group` |
| `trial_balance` | Monthly TB snapshots | `period_from`, `period_to`, `ledger_name`, `opening_balance`, `net_debit`, `net_credit`, `closing_balance` |
| `profit_loss` | Monthly P&L snapshots | `period_from`, `period_to`, `ledger_name`, `group_name`, `amount` |
| `balance_sheet` | Month-end BS snapshots | `as_on_date`, `ledger_name`, `group_name`, `closing_balance` |
| `vouchers` | Transaction-level daybook | `date`, `voucher_type`, `voucher_number`, `ledger_name`, `amount`, `party_name`, `narration`, `sync_month` |
| `stock_summary` | Monthly stock item snapshots | `item_name`, `stock_group`, `opening_qty/value`, `inward_qty/value`, `outward_qty/value`, `closing_qty/value` |
| `bills_outstanding` | Periodic receivable/payable snapshots | `nature`, `bill_date`, `reference_number`, `outstanding_amount`, `party_name`, `overdue_days` |
| `sync_log` | Extraction audit trail | `report_type`, `period_from`, `period_to`, `row_count`, `status`, `error_message`, `duration_ms` |

**Key constraints:**
- `vouchers` has `UNIQUE INDEX` on `(company_id, date, voucher_type, COALESCE(voucher_number,''), COALESCE(ledger_name,''), amount)` — prevents duplicate rows on re-sync
- All tables have `company_id` FK to `companies(id)` with `ON DELETE CASCADE`
- WAL mode + NORMAL synchronous for performance

---

## 6. API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/status` | Tally connectivity + company list from DB |
| POST | `/api/tally/connect` | Test/set Tally host+port |
| GET | `/api/tally/companies` | Live company list from Tally |
| POST | `/api/sync/start` | Start full sync `{companyName, fromDate, toDate, forceResync}` |
| GET | `/api/sync/progress` | Poll sync progress (step, message, %) |
| GET | `/api/sync/log` | Last 100 sync log entries |
| GET | `/api/companies` | Companies from local DB |
| GET | `/api/dashboard/kpi` | All KPI tiles `?companyId&fromDate&toDate` |
| GET | `/api/dashboard/monthly-trend` | Revenue/Expense/Profit by month |
| GET | `/api/dashboard/top-expenses` | Top 10 expense ledgers |
| GET | `/api/dashboard/top-revenue` | Top 10 revenue sources |
| GET | `/api/dashboard/expense-categories` | Expense by group |
| GET | `/api/dashboard/revenue-categories` | Revenue by group |
| GET | `/api/dashboard/receivable-ageing` | Debtor ageing by party |
| GET | `/api/dashboard/payable-ageing` | Creditor ageing by party |
| GET | `/api/dashboard/stock-summary` | Top stock items by closing value |
| GET | `/api/dashboard/trial-balance` | Full TB for date range |
| GET/POST | `/api/settings` | Read/write app_settings |

---

## 7. KPI / P&L Formula

```
Revenue         = sum of voucher amounts under "Sales Accounts" group tree
Direct Incomes  = sum under "Direct Incomes" group tree
Purchase        = sum under "Purchase Accounts" group tree (negated)
Direct Expenses = sum under "Direct Expenses" group tree (negated)

Gross Profit    = Revenue + Direct Incomes − Purchase − Direct Expenses

Indirect Incomes  = sum under "Indirect Incomes" group tree
Indirect Expenses = sum under "Indirect Expenses" group tree (negated)

Net Profit      = Gross Profit + Indirect Incomes − Indirect Expenses
```

The engine (`buildLedgerGroupMap` + `getGroupTree` + `computePLFlow`) builds everything in-memory — no SQL JOINs. Typical latency: **~25ms** for full KPI calculation on a year of data.

---

## 8. Voucher Sync — 8 Types Extracted

`Sales` · `Purchase` · `Receipt` · `Payment` · `Journal` · `Contra` · `Credit Note` · `Debit Note`

Each sync does **8 Tally HTTP requests** (one per type) instead of 96 (12 months × 8).
Each request returns ALL vouchers for Tally's current active period.
Client-side `validRows` filters them into the correct month buckets.

---

## 9. Critical Tally API Limitation (Must Know)

> **Tally's Collection API ignores `SVFROMDATE`/`SVTODATE` completely.**

When requesting voucher data, Tally always returns the vouchers for its **currently-active UI period** regardless of what date range is set in the request. This means:

- **To sync FY 2024–25:** Open Tally → press **F2** → set period to `1-Apr-2024 / 31-Mar-2025` → then run sync.
- **To sync FY 2025–26:** Set Tally period to `1-Apr-2025 / 31-Mar-2026` → sync.
- This was confirmed via exhaustive testing of `$InRange`, `$$StrToDate`, XML entities, CDATA, and `##SVFromDate` — none of these filter Tally's Collection output.
- `trial_balance`, `profit_loss`, `balance_sheet`, and `stock_summary` reports work correctly with date ranges (they use `TYPE=Data` reports, not `TYPE=Collection`).

---

## 10. Smart-Skip (Incremental Sync)

Historical months (any month before the current calendar month) that already have data in the DB are **skipped automatically** on subsequent syncs. The check is:

```sql
SELECT 1 FROM vouchers WHERE company_id=? AND date >= ? AND date <= ? LIMIT 1
```

Use `forceResync: true` in `POST /api/sync/start` to bypass and re-pull everything (e.g. after backdated corrections in Tally).

---

## 11. Completed Work — All Sessions

### Session 1 (9 Mar 2026)
| Fix | What Was Done |
|---|---|
| FIX-1 | DB moved from C: (system drive) to `D:\Tally\TallyVision\data\` |
| FIX-2 | 54,021 duplicate voucher rows removed; UNIQUE INDEX added; self-healing `runMigrations()` |
| FIX-3 | `return` inside `db.transaction` for-loop silently dropped vouchers — changed to pre-filter `validRows[]` |
| FIX-4 | Smart incremental sync — historical months already in DB are skipped |
| FIX-5 | `forceResync` flag added to sync endpoint for manual full re-pull |

### Session 2 (9 Mar 2026)
| Fix | What Was Done |
|---|---|
| FIX-6 | `parseNumber()` lost negative sign on Tally's `(1234.56)` format — fixed |
| FIX-7 | Same parentheses bug in `fetchVoucherCollection` inline `num()` — fixed |
| FIX-8 | Added `AllInventoryEntries` NATIVEMETHOD to capture Sales/Purchase ledger from inventory vouchers |
| FIX-9 | Bills Outstanding template completely rewritten — now uses nested `BillAllocations` walk for real bill-level data with correct `overdue_days` |

### Session 3 (9–11 Mar 2026)
| Fix | What Was Done |
|---|---|
| FIX-10 | Dashboard freeze fixed — 30s Tally timeout blocked all HTTP; `loadCompanies()` decoupled from `checkStatus()`; timeout reduced to 5s |
| FIX-11 | Voucher sync infinite re-sync loop fixed (NULL `sync_month` trap); progress bar frozen at 8% fixed |
| FIX-12 | Reverted broken date-filter experiments (confirmed Tally Collection API ignores date ranges) |
| FIX-13 | Fetch-once-per-type: 96 Tally requests → 8; phase 1 smart-skip + phase 2 distribute to month buckets |
| FIX-14 | DataExtractor sync timeout raised from 60s → 300s (large XML responses from pharma companies) |
| FIX-15 | Removed `AllInventoryEntries` NATIVEMETHOD — was causing 20–50MB XML responses (50+ stock lines per pharma invoice); `AllLedgerEntries` already contains all accounting entries including Sales/Purchase account |

---

## 12. Known Issues / Unresolved Items

| # | Issue | Severity | Notes |
|---|---|---|---|
| 1 | **"Tally Offline" badge during sync** | Low (cosmetic) | Tally's HTTP server is single-threaded — busy with sync XML generation, can't respond to status pings. Misleading but harmless. Fix: suppress offline badge when `syncInProgress = true`. |
| 2 | **Sync requires manual Tally period change** | Medium | User must press F2 in Tally to set correct FY before syncing historical data. No in-app guidance. Fix: detect active Tally period via `##SVCurrentDate` and warn the user if it mismatches the sync range. |
| 3 | **Zero voucher rows if Tally period is wrong** | High | If Tally's UI period doesn't match the requested FY, all vouchers pass through `validRows` filter, 0 rows are inserted, and no error is shown. Fix: after sync, check row count and show a warning if 0 vouchers were inserted for active months. |
| 4 | **Bills Outstanding: no bill-level data in DB** | Medium | The improved FIX-9 template may not be returning correct data yet — needs verification after a successful sync. |
| 5 | **No console logging for non-voucher sync steps** | Low | Only voucher extraction has `console.log`. Trial Balance, P&L, Balance Sheet, Stock steps are silent. Makes debugging difficult. |
| 6 | **`license` table is a stub** | Low | Schema exists with `max_companies`, `valid_until` etc. but no enforcement logic. |
| 7 | **No authentication on dashboard** | Medium | `dashboard_password` setting exists in DB but is never checked. Any local network user can access the dashboard if `lan_access=true`. |
| 8 | **`auto_sync` setting is stored but not implemented** | Medium | `node-cron` is in package.json but no scheduled sync job exists in `server.js`. |
| 9 | **Single company display only** | Medium | Dashboard shows one company at a time. Multi-company comparison not implemented. |
| 10 | **AllInventoryEntries removed — may miss edge cases** | Low | In rare Tally configurations where Sales/Purchase ledger is ONLY in `AllInventoryEntries` and NOT in `AllLedgerEntries`, those entries will be missing. Needs verification post-sync with `SUM(amount) GROUP BY voucher_type`. |

---

## 13. What Needs to Be Built Next (Roadmap)

### Priority 1 — Make V1 Reliable
- [ ] **Post-sync validation alert:** If 0 vouchers inserted for active months, show a clear warning "Tally period mismatch — press F2 in Tally to set the correct FY and re-sync"
- [ ] **Tally period indicator:** Show the active Tally period on the sync dialog (fetch it live from Tally before sync starts using `##SVCurrentDate`)
- [ ] **Suppress "Tally Offline" during sync:** When `syncInProgress=true`, don't show the offline badge
- [ ] **Verify Bills Outstanding data:** Run a sync and confirm bill-level rows with real `bill_date` and `overdue_days` are landing in `bills_outstanding` table
- [ ] **Console logging for all sync steps:** Add `console.log` to TB, P&L, BS, Stock extract loops

### Priority 2 — Core Features
- [ ] **Auto-sync scheduler:** Implement the `node-cron` job using the `auto_sync` and `sync_interval_minutes` settings already in DB. Should auto-sync daily (or on configurable interval) for the current FY.
- [ ] **Multi-FY navigation:** Allow syncing and viewing multiple financial years, switchable from the dashboard date-range picker
- [ ] **Export to Excel/PDF:** Dashboard KPIs and charts exportable as a report
- [ ] **Dashboard password protection:** Implement `dashboard_password` check; basic login page
- [ ] **LAN access toggle:** When `lan_access=true`, bind Express to `0.0.0.0` instead of `localhost`

### Priority 3 — Product Features
- [ ] **Multi-company support:** Sync and compare multiple Tally companies side by side
- [ ] **Voucher drill-down:** Click on any KPI tile → see the underlying voucher list
- [ ] **GST summary report:** GSTR-1 / GSTR-3B style breakdowns using voucher data
- [ ] **Party-wise ledger statement:** Select any party → see all transactions in date range
- [ ] **Budget vs Actual:** If budget data is maintained in Tally, pull and display variance
- [ ] **License enforcement:** Implement `max_companies` and `valid_until` from the `license` table
- [ ] **Installer / Setup wizard:** Currently relies on `install.bat` and manual steps; build a proper first-run wizard

### Priority 4 — Infrastructure
- [ ] **Proper error boundaries in dashboard:** API failures currently show blank tiles with no message
- [ ] **Sync history UI:** Show the `sync_log` table in a readable format on the dashboard
- [ ] **DB backup utility:** One-click backup of `tallyvision.db` to a user-specified path
- [ ] **Tally ERP 9 compatibility testing:** Currently assumed to work, untested

---

## 14. Tally XML API Notes (For Future Development)

### What works reliably
- `TYPE=Data` with custom TDL reports (Trial Balance, P&L, Balance Sheet, Stock) — **respects date ranges**
- `TYPE=Collection` with `TYPE=Voucher` + `AllLedgerEntries` NATIVEMETHOD — **ignores date ranges, returns current Tally period**
- `TYPE=Collection` with `TYPE=Ledger` — works for Chart of Accounts and Ledger master
- TCP ping on port 9000 for health check
- utf-16le encoding for both request and response

### What does NOT work
- `SVFROMDATE`/`SVTODATE` in Collection exports — completely ignored by Tally
- `$InRange:$Date:##SVFromDate:##SVToDate` — silently returns 0 vouchers
- `$StrToDate` comparisons — returns 0
- `##SVFromDate` in TDL formulae reflects Tally's UI period, not our request values
- `AllInventoryEntries` NATIVEMETHOD — causes extremely large XML for inventory-heavy companies (pharma, etc.); safe to omit since `AllLedgerEntries` contains the same accounting data

### Encoding
```js
const data = Buffer.from(xml, 'utf16le');   // request
res.setEncoding('utf16le');                 // response
```

---

## 15. Environment & Configuration

| Setting | Default | Where |
|---|---|---|
| Tally host | `localhost` | `app_settings.tally_host` |
| Tally port | `9000` | `app_settings.tally_port` |
| Dashboard port | `3456` | `app_settings.dashboard_port` |
| DB path | `D:\Tally\TallyVision\data\tallyvision.db` | `setup.js` or `TALLYVISION_DATA` env var |
| Auto sync | `true` (stored, not enforced) | `app_settings.auto_sync` |
| Sync interval | `60` minutes (stored, not enforced) | `app_settings.sync_interval_minutes` |
| Theme | `dark` | `app_settings.theme` |
| LAN access | `false` | `app_settings.lan_access` |
| Password | `''` (empty = disabled) | `app_settings.dashboard_password` |

---

## 16. Dependencies

| Package | Version | Purpose |
|---|---|---|
| `express` | ^4.21.0 | HTTP server + REST API |
| `better-sqlite3` | ^11.0.0 | Synchronous SQLite (fast, no async overhead) |
| `fast-xml-parser` | ^5.3.5 | Parse Tally's XML responses |
| `cors` | ^2.8.5 | Allow browser fetch from same origin |
| `node-cron` | ^3.0.3 | Scheduled sync (imported but not yet used) |
| `uuid` | ^10.0.0 | Imported but not yet used |

Frontend uses CDN links (no npm): **Chart.js**, **Tailwind CSS**, **Font Awesome**.

---

*Document generated: March 2026 — covers all work from FIX-1 through FIX-15*
