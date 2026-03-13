# TallyVision

**MIS Dashboard for Tally Prime & ERP 9**

TallyVision extracts financial data from Tally Prime (or ERP 9) over its native XML/HTTP interface and presents it as an interactive, web-based MIS dashboard with KPIs, charts, drill-downs, and trend analysis — all running locally on your machine. No cloud, no internet required.

---

## Features

### Real-Time KPI Cards
- **Gross Profit & Gross Margin %** — Revenue minus direct costs
- **Net Profit & Net Margin %** — Bottom-line profitability
- **Total Revenue** — All income streams (Sales + Direct Incomes)
- **Total Direct Expenses** — Purchases, manufacturing, direct costs
- **Total Indirect Expenses** — Overheads, admin, selling expenses
- **Receivables & Payables** — Outstanding debtor/creditor totals
- **Cash & Bank** — Liquid position
- **Loans & Advances** — Borrowing position

### Interactive Charts
- **Top Revenue Sources** — Doughnut chart of highest-earning ledgers
- **Top Direct Expenses** — Visual breakdown of direct cost heads
- **Top Indirect Expenses** — Overhead cost distribution
- **YTD Monthly Trend** — Revenue vs Expenses bar chart with GP/NP lines

### Drill-Down Analysis
Click any KPI card or chart segment to open a detailed analysis overlay:
- **Pie chart** of group/ledger composition
- **Sortable table** with amounts, percentages, and running totals
- **Breadcrumb navigation** through multi-level group hierarchy
- Works for both P&L classes and Balance Sheet groups

### Financial Reports
- **Trial Balance** — Monthly period-end balances for every ledger
- **Receivable Ageing** — Debtor bills with overdue-days bucketing (0-30, 31-60, 61-90, 90+)
- **Payable Ageing** — Creditor bills with the same aging structure
- **Stock Summary** — Inventory valuation with opening/closing quantities and values

### Optional Modules (Per-Company Toggle)
- **GST Analysis** — Tax entries with IGST/CGST/SGST breakdowns
- **Cost Centre Analysis** — Expense allocation across cost centres
- **Payroll Summary** — Employee pay-head wise breakdown

### Data Sync Engine
- **One-click sync** from the Settings panel
- **Smart chunking** — Trial balance and vouchers extracted month-by-month (12 requests/year), stock summary quarterly
- **Bare Collection API** — No SYSTEM Formulae filters (avoids crashes with certain Tally configurations)
- **Force Resync** option for full re-extraction when needed
- **Live progress bar** with real-time status updates
- **Sync log** for audit trail of every extraction

---

## Requirements

- **Node.js** v18 or later
- **Tally Prime** (or Tally ERP 9) running with its XML/HTTP server enabled
- Both Tally and TallyVision must run on the same machine (or be network-accessible)

### Tally Configuration
1. Open Tally Prime
2. Press **F12** (Configuration) or go to **F1 > Settings > Connectivity**
3. Set **Enable ODBC / XML Server** to **Yes**
4. Note the port (default: **9000**)

---

## Installation

```bash
# Clone the repository
git clone https://github.com/Laaxxmm/Tally_Vision.git
cd Tally_Vision

# Install dependencies
npm install

# Initialize the database (first time only)
npm run setup-db

# Start the server
npm start
```

The dashboard opens at **http://localhost:3456**

---

## Quick Start

1. **Start Tally Prime** with at least one company open
2. **Run** `npm start` — server launches on port 3456
3. **Open** http://localhost:3456 in your browser
4. **Click the Settings icon** (top-right) to configure:
   - Tally Host (default: `localhost`) and Port (default: `9000`)
   - Fiscal year start/end dates
   - Select the company to sync
   - Enable optional modules (GST, Cost Centres, Payroll) if needed
5. **Click Sync** — watch the progress bar as data extracts
6. **Explore** — click KPI cards, chart segments, and table rows to drill down

---

## Architecture

```
Tally Prime / ERP 9
    |  (XML over HTTP, port 9000)
    v
TallyConnector            UTF-16LE encoded XML requests/responses
    |
    v
DataExtractor             Chunked month-by-month extraction
    |
    v
SQLite Database           Local storage (data/tallyvision.db)
    |
    v
Express REST API          Dynamic TB engine, in-memory computation
    |
    v
Dashboard SPA             Chart.js + Tailwind CSS single-page app
```

### Key Design Decisions
- **Dynamic TB Engine** — Builds in-memory ledger-to-group maps, computes all P&L/BS figures in Node.js (~8ms per query). No SQL JOINs.
- **P&L Classification** — Uses Tally's `bs_pl`, `dr_cr`, `affects_gross_profit` metadata to automatically classify all groups (including custom ones) into Revenue, Direct Expenses, Indirect Expenses, etc.
- **Monthly TB Chunks** — Trial balance extracted per-month (12 requests/year) ensures accurate period data without cumulative distortion.
- **Bare Collection API** — Voucher extraction uses no SYSTEM Formulae filters, preventing "Bad formula!" crashes with certain Tally company configurations.
- **TB-Based Trends** — Monthly trend chart uses Trial Balance data (not vouchers) for authoritative P&L breakdown, since Tally's Collection API doesn't expand ledger details for all voucher types (notably Purchase).

---

## Project Structure

```
TallyVision/
├── package.json
├── README.md
├── HANDOFF.md
├── src/
│   ├── backend/
│   │   ├── server.js                  # Express REST API + Dynamic TB engine
│   │   ├── tally-connector.js         # TCP ping + XML communication (utf-16le)
│   │   ├── run-extraction.js          # CLI extraction runner
│   │   ├── db/
│   │   │   └── setup.js               # SQLite schema (14 tables, migrations)
│   │   └── extractors/
│   │       ├── xml-templates.js       # TDL XML templates for Tally reports
│   │       └── data-extractor.js      # Chunked extraction engine
│   └── frontend/
│       └── dashboard.html             # Single-page dashboard (Chart.js + Tailwind)
└── data/
    └── tallyvision.db                 # SQLite database (auto-created, not in git)
```

---

## API Reference

All endpoints are prefixed with `/api`.

### Status & Connection
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Tally connection & last sync status |
| POST | `/api/tally/connect` | Test connection to Tally |
| GET | `/api/tally/companies` | List companies open in Tally |

### Sync Control
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/sync/start` | Start data extraction (`companyName`, `fromDate`, `toDate`, `forceResync`) |
| GET | `/api/sync/progress` | Poll sync progress (step, message, %) |
| GET | `/api/sync/log` | Sync history log |

### Dashboard KPIs & Trends
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dashboard/kpi` | GP, NP, Revenue, Expenses, Margins, Receivables, Payables, Cash & Bank |
| GET | `/api/dashboard/monthly-trend` | Monthly Revenue, Expenses, GP, NP (TB-based) |
| GET | `/api/dashboard/top-expenses` | Top 10 expense ledgers |
| GET | `/api/dashboard/top-direct-expenses` | Top direct expense ledgers |
| GET | `/api/dashboard/top-indirect-expenses` | Top indirect expense ledgers |
| GET | `/api/dashboard/top-revenue` | Top 10 revenue sources |

### Drill-Down & Breakdown
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dashboard/expense-categories` | Expense group breakdown |
| GET | `/api/dashboard/revenue-categories` | Revenue group breakdown |
| GET | `/api/dashboard/ledger-breakdown` | Drill-down by `classType` or `groupRoot` |
| GET | `/api/dashboard/group-breakdown` | Hierarchical group drill-down with children |
| GET | `/api/dashboard/item-monthly-trend` | Per-item/group YTD monthly trend |

### Financial Statements
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dashboard/trial-balance` | Period trial balance |
| GET | `/api/dashboard/receivable-ageing` | Debtor ageing by party |
| GET | `/api/dashboard/payable-ageing` | Creditor ageing by party |
| GET | `/api/dashboard/stock-summary` | Inventory valuation |
| GET | `/api/dashboard/stock-item-ledger` | Stock item movement history |
| POST | `/api/sync/stock-item-ledger` | On-demand stock item extraction |

### Optional Modules
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dashboard/gst-summary` | GST tax entries summary |
| GET | `/api/dashboard/cost-centre-analysis` | Cost centre breakdown |
| GET | `/api/dashboard/payroll-summary` | Payroll analysis |

### Settings & Companies
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET/POST | `/api/settings` | Read/write app settings |
| GET | `/api/companies` | List synced companies |
| GET/POST | `/api/companies/:id/modules` | Get/toggle optional modules per company |

---

## npm Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Start the server (port 3456) |
| `npm run extract` | Run CLI extraction (headless) |
| `npm run setup-db` | Initialize/reset the database |

---

## Supported Tally Versions

| Version | Status |
|---------|--------|
| Tally Prime (Release 4+) | Fully supported |
| Tally Prime Gold | Fully supported |
| Tally ERP 9 | Basic support (untested edge cases) |

---

## Troubleshooting

### Tally connection fails
- Ensure Tally is running with XML/HTTP server enabled (F12 > Enable ODBC Server = Yes)
- Verify the port matches (default 9000)
- Allow Tally's port in Windows Firewall if blocked

### Sync takes too long
- First sync extracts a full year — expect 2-5 minutes depending on company size
- Subsequent syncs skip already-cached months (smart-skip)
- Large companies (50,000+ vouchers) may take longer

### KPI values don't match Tally
- Ensure fiscal year dates in Settings match Tally's accounting period
- Try a **Force Resync** (checkbox in Settings) to re-extract all data
- Custom voucher types are captured automatically — no configuration needed

### Dashboard shows empty charts
- Complete a sync first — charts require data in the local database
- Check the date range selector matches your fiscal period
- Verify Tally's active period (F2 in Tally) covers the same date range

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Node.js + Express |
| Database | SQLite via better-sqlite3 |
| XML Parsing | fast-xml-parser |
| Frontend | Vanilla JS, Tailwind CSS (CDN) |
| Charts | Chart.js v4 (CDN) |
| Icons | Font Awesome (CDN) |

---

## Data Privacy

All data stays on your local machine. TallyVision:
- Stores data in a local SQLite file (`data/tallyvision.db`)
- Makes no outbound internet connections
- Requires no cloud accounts or API keys
- Runs entirely offline after `npm install`

---

## License

MIT
