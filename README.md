# TallyVision - MIS Dashboard for Tally Prime & ERP 9

## Quick Start

### 1. Install Dependencies
```bash
cd D:\Tally\TallyVision
npm install
```

### 2. Initialize Database
```bash
npm run setup-db
```

### 3. Start the Dashboard Server
```bash
npm start
```
Then open **http://localhost:3456** or open `src/frontend/dashboard.html` directly.

### 4. Extract Data from Tally
Make sure Tally is running with a company open, then:
```bash
npm run extract -- --company "Your Company Name" --from 2025-04-01 --to 2026-03-31
```

Or use the Settings panel in the dashboard UI to start sync.

### 5. Custom Tally Port
If Tally runs on a non-default port:
```bash
npm run extract -- --company "Your Company Name" --port 9001
```

## Project Structure
```
TallyVision/
├── package.json
├── src/
│   ├── backend/
│   │   ├── server.js              # REST API server (Express)
│   │   ├── tally-connector.js     # Tally TCP/XML connection manager
│   │   ├── run-extraction.js      # CLI extraction runner
│   │   ├── db/
│   │   │   └── setup.js           # SQLite schema & migrations
│   │   └── extractors/
│   │       ├── xml-templates.js   # All Tally XML report templates
│   │       └── data-extractor.js  # Chunked extraction engine
│   └── frontend/
│       └── dashboard.html         # MIS Dashboard UI
```

## Architecture
```
Tally Prime/ERP9 (port 9000)
    ↓ XML over HTTP
TallyVision Extractor (Node.js)
    ↓ Chunked monthly pulls
SQLite Database (local file)
    ↓ REST API
Dashboard UI (Chart.js + Tailwind)
```

## API Endpoints
- `GET /api/status` - Tally connection + sync status
- `POST /api/sync/start` - Start data extraction
- `GET /api/sync/progress` - Poll sync progress
- `GET /api/dashboard/kpi` - KPI summary
- `GET /api/dashboard/monthly-trend` - Revenue vs Expense monthly
- `GET /api/dashboard/top-expenses` - Top 10 expenses
- `GET /api/dashboard/top-revenue` - Top 10 revenue sources
- `GET /api/dashboard/expense-categories` - Expense breakdown
- `GET /api/dashboard/revenue-categories` - Revenue breakdown
- `GET /api/dashboard/receivable-ageing` - Debtor ageing
- `GET /api/dashboard/payable-ageing` - Creditor ageing
- `GET /api/dashboard/stock-summary` - Inventory valuation
- `GET /api/settings` - App settings
- `POST /api/settings` - Update settings

## Data Storage
All financial data is stored locally in:
`%LOCALAPPDATA%\TallyVision\tallyvision.db`

No cloud, no internet required. Fully offline operation.
