# TallyVision — Change Log

All fixes are documented here with root cause, file affected, and what changed.

---

## Session 1 — 2026-03-09

### [FIX-1] DB moved from C drive to project directory
**File:** `src/backend/db/setup.js`
**Root cause:** DB was hardcoded to `%LOCALAPPDATA%\TallyVision\tallyvision.db` (C drive), filling up the system drive.
**Fix:** Changed default `DB_DIR` to `path.join(__dirname, '..', '..', '..', 'data')` → resolves to `D:\Tally\TallyVision\data\`. Env variable `TALLYVISION_DATA` still overrides if needed.

---

### [FIX-2] Voucher deduplication — 54,021 duplicate rows removed
**File:** `src/backend/db/setup.js`
**Root cause:** Three compounding bugs caused vouchers to be stored N×:
  1. No UNIQUE constraint on `vouchers` table — repeated syncs piled rows endlessly.
  2. The pre-sync `DELETE` used the full date range, so months from a *previous wider-range sync* were never cleaned up.
  3. A `return` inside the transaction for-loop (Bug #3 below) caused partial inserts which compounded across re-runs.
**Fix:** Added `runMigrations()` called from `initDatabase()` that:
  - Deletes all duplicate rows (`WHERE rowid NOT IN (SELECT MIN(rowid) ... GROUP BY company_id, date, voucher_type, COALESCE(voucher_number,''), COALESCE(ledger_name,''), amount)`)
  - Creates `CREATE UNIQUE INDEX IF NOT EXISTS idx_vch_unique` on the same key set.
  - Self-healing: runs on every server start, no-ops if nothing to clean.

---

### [FIX-3] `return` inside transaction for-loop exited entire batch silently
**File:** `src/backend/extractors/data-extractor.js` → `extractVouchers()`
**Root cause:** `if (parsedDate < c.from || parsedDate > c.to) return;` — `return` exits the `db.transaction(fn)` callback function entirely, not just the current loop iteration. All vouchers after the first out-of-range one were silently dropped; whatever was inserted before was committed.
**Fix:** Moved date parsing and range-filtering into a `validRows[]` pre-filter array **before** the transaction. The transaction now only iterates over already-clean rows.

---

### [FIX-4] Smart incremental sync — skip already-synced historical months
**File:** `src/backend/extractors/data-extractor.js`
**Root cause:** Every sync call re-fetched and re-wrote all months in the requested range, even if those months were already complete and would never change (closed financial periods).
**Fix:** Added `isHistoricalMonth(yearMonth)` helper. Before each month chunk in `extractTrialBalance`, `extractProfitLoss`, `extractBalanceSheet`, `extractStockSummary`, and `extractVouchers`:
  - If month < current month **AND** data already exists in DB → **skip** (logs "cached").
  - If month is current/future or data is missing → fetch fresh.
  - Changed voucher DELETE scope from full date range to `per-month` (`sync_month = ?`), so re-syncing one month never disturbs others.
  - Changed all INSERTs to `INSERT OR IGNORE` as a secondary guard.

---

### [FIX-5] forceResync flag added to sync endpoint
**File:** `src/backend/server.js`, `src/backend/extractors/data-extractor.js`
**Root cause:** No way to force a full re-pull when backdated corrections exist in Tally.
**Fix:** `POST /api/sync/start` now accepts `{ forceResync: true }` in body. Passed through `runFullSync(options)` → all extract methods. When `true`, skips the "cached" check and re-syncs every month.

---

## Session 2 — 2026-03-09

### [FIX-6] `parseNumber()` strips parentheses — loses negative sign
**File:** `src/backend/extractors/data-extractor.js` → `parseNumber()`
**Root cause:** `String(val).replace(/[\(\),\s]+/g, '')` strips both parentheses and comma from Tally's number format, but Tally uses `(1234.56)` to denote **negative** values. Result: `-₹12.3L` was stored as `+₹12.3L` for any ledger with a credit/debit opening balance in parentheses form.
**Fix:** Detect leading/wrapping `(...)` pattern **before** stripping and prepend `-` if found.

---

### [FIX-7] `num()` in `fetchVoucherCollection` same parentheses issue
**File:** `src/backend/extractors/data-extractor.js` → `fetchVoucherCollection()`
**Root cause:** Same as FIX-6. The inline `num()` helper strips `[^\d.\-]` which also removes the closing `)`, leaving just digits when input is `(199)`.
**Fix:** Same parentheses-to-negative detection applied to `num()`.

---

### [FIX-8] Missing `AllInventoryEntries` in daybook NATIVEMETHOD
**File:** `src/backend/extractors/xml-templates.js` → `daybook` template
**Root cause:** The daybook Collection XML only declared `<NATIVEMETHOD>AllLedgerEntries</NATIVEMETHOD>`. In Tally Prime, Sales and Purchase vouchers store the Sales A/c and Purchase A/c ledger entries inside `AllInventoryEntries → AccountingAllocations`, **not** in `AllLedgerEntries`. Without requesting `AllInventoryEntries`, Tally doesn't return those entries — so the Sales/Purchase ledger rows were never captured. The parser code already handled `ALLINVENTORYENTRIES.LIST` but the data was never coming back.
**Fix:** Added `<NATIVEMETHOD>AllInventoryEntries</NATIVEMETHOD>` to the daybook template. This makes Tally return the nested inventory entries including their accounting allocations, which `fetchVoucherCollection` already parses correctly.

---

### [FIX-9] Bills Outstanding — wrong collection, overdue_days always 0
**File:** `src/backend/extractors/xml-templates.js` → `bills-outstanding` template
**Root cause:** Template used `Ledger` collection with `$BillDate` (not a valid Ledger field), `$Name` (ledger name, not bill ref), and hardcoded `0` for overdue_days. Result: one row per ledger with total balance, no individual bill detail, no dates, no ageing.
**Fix:** Rewrote template to use a nested TDL walk: `Ledger` → repeat over `BillAllocations` list → extract `Name` (bill ref), `BillDate`, `Amount`, parent ledger name, and compute `$$NumValue:$$Age:$BillDate` for actual overdue days.

---

## Session 3 — 2026-03-09

### [FIX-10] Dashboard freeze — 30s Tally timeout blocked all HTTP requests
**Files:** `src/backend/tally-connector.js`, `src/frontend/dashboard.html`
**Root cause:** Three compounding issues caused the dashboard to freeze completely on load:
  1. `TallyConnector` default `timeout` was 30,000ms. Every call to `/api/status` fired `tally.healthCheck()` → `sendXML()` which held an HTTP connection open for up to 30 seconds waiting for Tally to respond.
  2. On page load, `window.addEventListener('load', ...)` did `await checkStatus()` **before** calling `loadDashboard()`. This meant the entire UI blocked — company dropdown empty, all charts blank — until the 30-second Tally timeout expired.
  3. `checkStatus()` was responsible for both the Tally status indicator AND populating the company dropdown from `status.database.companies`. So if Tally was slow/offline, the company list never populated, and `loadDashboard()` was never called because `currentCompanyId` stayed null.
  Additionally: `setInterval(checkStatus, 30000)` re-triggered this every 30 seconds, creating a cascading pile of hung connections (observed as 100+ TIME_WAIT entries in netstat and ERR_ABORTED in the browser network tab).
**Fix (3 changes):**
  - **`tally-connector.js`:** Reduced `this.timeout` default from `30000` → `5000` ms. Five seconds is more than adequate for a local or LAN connection; if Tally doesn't respond in 5s it's effectively offline.
  - **`dashboard.html` — split `checkStatus()` / add `loadCompanies()`:** `checkStatus()` now only updates the Tally status indicator (green/red dot). It no longer touches the company dropdown. A new `loadCompanies()` function hits `/api/companies` (pure SQLite query, returns in <5ms regardless of Tally state) to populate the dropdown.
  - **`dashboard.html` — fix init sequence:** Changed `window.addEventListener('load', ...)` from:
    ```
    await checkStatus();   // blocked here up to 30s
    loadDashboard();
    ```
    to:
    ```
    await loadCompanies(); // <5ms DB query
    loadDashboard();       // starts immediately
    checkStatus();         // fire-and-forget, never blocks UI
    ```
  Net result: dashboard data and company list load in <100ms; Tally status indicator updates asynchronously in the background.

---

### [FIX-11] Voucher sync stuck in infinite re-sync loop + progress bar frozen at 8%
**File:** `src/backend/extractors/data-extractor.js` → `extractVouchers()`
**Root cause (2 bugs):**
  1. **NULL sync_month trap (infinite re-sync loop):** Vouchers synced before FIX-4 have `sync_month = NULL` in the DB (the column didn't exist at that time). The smart skip check used `WHERE sync_month = '2024-04'` which never matches NULL rows → skip always fails → `DELETE WHERE sync_month = '2024-04'` deletes nothing (NULL rows survive) → new `INSERT OR IGNORE` silently ignores every row (unique key already exists from old data) → no data changes, no error logged → every subsequent sync repeats this loop forever.
  2. **Progress bar frozen at 8% (UX bug):** Progress was calculated as `(i+1) / chunks.length` where `i` is the month index. For a 12-month sync with 8 voucher types per month = 96 total Tally requests, all 8 types of month 0 (Apr 2024) all reported `8%`. Bar appeared frozen for several minutes while each type was fetched one by one.
**Fix:**
  - **Smart skip:** Changed to `WHERE date >= ? AND date <= ?` (date range) instead of `WHERE sync_month = ?`. Correctly detects existing vouchers regardless of their `sync_month` value (NULL or actual).
  - **Pre-fetch DELETE:** Changed to `WHERE date >= ? AND date <= ?` so old NULL-sync_month rows are actually cleared before re-fetching, allowing new rows to be inserted with the correct `sync_month`.
  - **Progress granularity:** Changed loop to `for (let j = 0; j < types.length; j++)` and updated formula to `(i * types.length + j + 1) / (chunks.length * types.length)`. Bar now advances ~1% per Tally request (96 steps for 12 months) instead of being stuck for 8 requests at a time.

---
## Session 3 — 2026-03-09 (continued)

### [FIX-12] Reverted broken date-filter experiment in daybook template
**File:** `src/backend/extractors/xml-templates.js`
**Root cause discovered via diagnostics:**
- Tally's Collection API (`TYPE=Collection`) **completely ignores** `SVFROMDATE`/`SVTODATE` set in `STATICVARIABLES`. It always returns vouchers for Tally's currently-active UI period.
- `##SVFromDate` / `##SVToDate` in TDL formulae reflect Tally's current-period dates, NOT the values we set.
- `$$InRange`, `$$StrToDate`, and CDATA approaches all fail silently (return 0 vouchers with no error).
- The only working approach is: no date filter at all (rely on client-side `validRows` filtering).
**Fix:** Reverted to clean original template with no formula date filter. Added a comment documenting the limitation.

### [FIX-13] Voucher sync: fetch-once-per-type (8 requests instead of 96)
**File:** `src/backend/extractors/data-extractor.js` → `extractVouchers()`
**Root cause of 25-minute sync:**
- Old architecture: outer loop = months (12), inner loop = types (8) → **96 Tally requests** per FY sync.
- Each request returned Tally's full active-period dataset (~12MB) since date filtering doesn't work.
- For a fresh sync with no cached data: 96 × ~20s per request = ~32 minutes.
**New architecture (Phase 1 + Phase 2):**
- Phase 1: scan all month chunks, run smart-skip (date-range based), DELETE stale rows for months that need refresh. Collect `activeChunks[]`.
- Phase 2: **one Tally request per voucher type** (8 total). Parse all returned rows once. Distribute to `activeChunks` using `validRows` filter.
- Result: **8 requests** instead of 96 → ~12× faster. Fresh FY sync now completes in ~5–10 seconds.
**Important Tally API limitation documented:**
- Tally's Collection export only surfaces the currently-active Tally period's vouchers.
- To sync a historical FY (e.g. 2024–25) when Tally's UI is set to 2025–26: the user must temporarily change Tally's period (F2 in Tally) to the historical FY, run sync, then switch back.

---

## Session 4 — 2026-03-11

### [FEAT-1] YTD default dates on dashboard load
**File:** `src/frontend/dashboard.html`
**Change:** Replaced hardcoded `value="2024-04-01"` / `value="2025-03-31"` on date inputs with dynamic `getYTDDates()` function called on `window.load`. Computes FY start year as `current year if month ≥ April, else current year − 1`. `fromDate` = `fyStartYear-04-01`, `toDate` = today's date in `YYYY-MM-DD`.

---

### [FEAT-2] Loans card removed from KPI grid
**File:** `src/frontend/dashboard.html` → `renderKPIs()`
**Change:** Removed the Loans card entry from the `kpis` array. Dashboard now shows 9 KPI cards. Grid remains `lg:grid-cols-5` (2 rows: 5+4).

---

### [FEAT-3] Q1/Q2/Q3/Q4 shortcut buttons with contiguous multi-select
**File:** `src/frontend/dashboard.html`
**Change:** Added four quarter buttons (`Q1`–`Q4`) in the header next to the date inputs. Indian FY quarters: Q1=Apr–Jun, Q2=Jul–Sep, Q3=Oct–Dec, Q4=Jan–Mar. Logic:
- Clicking an unselected Q sets it as the only selection.
- Clicking an **adjacent** Q extends the contiguous range (Q1→Q2 = Apr–Sep; Q1→Q3 = Apr–Dec, etc.).
- Clicking a non-adjacent Q resets to just that quarter.
- Changing dates manually clears quarter highlight.
- Quarter change calls `loadDashboard()` immediately (no Apply button needed).
CSS `.q-btn.active` highlights selected buttons in blue.

---

### [FEAT-4] Single combined trend chart with dropdown
**Files:** `src/frontend/dashboard.html`, `src/backend/server.js`
**Change:** Replaced two separate chart containers (`chartRevExp` bar + `chartProfit` line) with one full-width `chartTrend` canvas and a `<select>` dropdown:
- **"Revenue vs Expenses"** → dual-bar chart (green = Revenue, red = Expenses) — identical to old `chartRevExp`.
- **"GP% vs NP% Ratio"** → dual-line chart with GP% (green) and NP% (blue) per month. Y-axis shows percentages.
Trend data cached in `cachedTrend` — dropdown switch re-renders without a new API call.
**Backend:** Enhanced `/api/dashboard/monthly-trend` to return `grossProfit` and `netProfit` per month (in addition to `revenue` and `expenses`). Separated the old combined `expSet` into individual sets for `purchaseSet`, `directExpSet`, `directIncSet`, `indirectExpSet`, `indirectIncSet`. GP/NP formula mirrors the KPI endpoint exactly.

---

### [FEAT-5] Card click drill-down analysis pages
**Files:** `src/frontend/dashboard.html`, `src/backend/server.js`
**Cards with analysis (7):**
| Card | Analysis Type | Chart |
|------|--------------|-------|
| Revenue | Ledger breakdown via `/ledger-breakdown?groupRoot=Sales Accounts` | Doughnut pie |
| Purchase | Ledger breakdown via `groupRoot=Purchase Accounts` | Doughnut pie |
| Direct Expenses | Ledger breakdown via `groupRoot=Direct Expenses` | Doughnut pie |
| Indirect Expenses | Ledger breakdown via `groupRoot=Indirect Expenses` | Doughnut pie |
| Receivables | Top debtors from `/receivable-ageing` | Horizontal bar |
| Payables | Top creditors from `/payable-ageing` | Horizontal bar |
| Cash & Bank | Individual balances from `/ledger-breakdown?groupRoot=Cash-in-Hand,Bank Accounts&mode=balance` | Horizontal bar |

**Cards without analysis:** Gross Profit, Net Profit (no onclick).

**Overlay:** Full-screen `fixed inset-0 z-40 bg-slate-950` panel with "← Back to Dashboard" button, title, and chart. Hidden by default (`hidden` class), shown on card click.

**New backend endpoint:** `GET /api/dashboard/ledger-breakdown?companyId&fromDate&toDate&groupRoot&mode`
- `mode=balance`: reads `trial_balance` closing_balance for latest month ≤ toDate (for BS items like Cash/Bank).
- `mode` omitted: sums `vouchers` by ledger for the date range (for P&L flow items).
- `groupRoot` can be comma-separated for multiple root groups.

