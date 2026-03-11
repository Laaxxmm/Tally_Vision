/**
 * TallyVision - SQLite Database Setup & Migration
 * All data stored locally on client machine
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = process.env.TALLYVISION_DATA || path.join(__dirname, '..', '..', '..', 'data');

function getDbPath() {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    return path.join(DB_DIR, 'tallyvision.db');
}

function initDatabase(dbPath) {
    const db = new Database(dbPath || getDbPath());

    // Performance settings for SQLite
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');

    createSchema(db);
    runMigrations(db);
    return db;
}

function createSchema(db) {
    db.exec(`
        -- ============================================
        -- CONFIGURATION & SETTINGS
        -- ============================================
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- ============================================
        -- LICENSE MANAGEMENT (Simple Key for V1)
        -- ============================================
        CREATE TABLE IF NOT EXISTS license (
            id INTEGER PRIMARY KEY DEFAULT 1,
            license_key TEXT,
            max_companies INTEGER DEFAULT 1,
            valid_until DATE,
            activated_at DATETIME,
            CHECK (id = 1)
        );

        -- ============================================
        -- COMPANY METADATA
        -- ============================================
        CREATE TABLE IF NOT EXISTS companies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            guid TEXT,
            fy_start_month INTEGER DEFAULT 4,
            fy_from DATE,
            fy_to DATE,
            tally_version TEXT,
            last_full_sync_at DATETIME,
            last_incremental_sync_at DATETIME,
            sync_from_date DATE,
            sync_to_date DATE,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- ============================================
        -- CHART OF ACCOUNTS (Group Hierarchy)
        -- ============================================
        CREATE TABLE IF NOT EXISTS account_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
            group_name TEXT NOT NULL,
            parent_group TEXT,
            bs_pl TEXT CHECK (bs_pl IN ('BS', 'PL')),
            dr_cr TEXT CHECK (dr_cr IN ('D', 'C')),
            affects_gross_profit TEXT CHECK (affects_gross_profit IN ('Y', 'N')),
            UNIQUE(company_id, group_name)
        );

        -- ============================================
        -- LEDGER MASTER LIST
        -- ============================================
        CREATE TABLE IF NOT EXISTS ledgers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            group_name TEXT,
            parent_group TEXT,
            UNIQUE(company_id, name)
        );

        -- ============================================
        -- TRIAL BALANCE (Monthly Snapshots)
        -- ============================================
        CREATE TABLE IF NOT EXISTS trial_balance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
            period_from DATE NOT NULL,
            period_to DATE NOT NULL,
            ledger_name TEXT NOT NULL,
            group_name TEXT,
            opening_balance REAL DEFAULT 0,
            net_debit REAL DEFAULT 0,
            net_credit REAL DEFAULT 0,
            closing_balance REAL DEFAULT 0,
            synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(company_id, period_from, period_to, ledger_name)
        );
        CREATE INDEX IF NOT EXISTS idx_tb_company_period ON trial_balance(company_id, period_from, period_to);
        CREATE INDEX IF NOT EXISTS idx_tb_group ON trial_balance(group_name);

        -- ============================================
        -- PROFIT & LOSS (Monthly Snapshots)
        -- ============================================
        CREATE TABLE IF NOT EXISTS profit_loss (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
            period_from DATE NOT NULL,
            period_to DATE NOT NULL,
            ledger_name TEXT NOT NULL,
            group_name TEXT,
            amount REAL DEFAULT 0,
            synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(company_id, period_from, period_to, ledger_name)
        );
        CREATE INDEX IF NOT EXISTS idx_pl_company_period ON profit_loss(company_id, period_from, period_to);
        CREATE INDEX IF NOT EXISTS idx_pl_group ON profit_loss(group_name);

        -- ============================================
        -- BALANCE SHEET (Monthly End Snapshots)
        -- ============================================
        CREATE TABLE IF NOT EXISTS balance_sheet (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
            as_on_date DATE NOT NULL,
            ledger_name TEXT NOT NULL,
            group_name TEXT,
            closing_balance REAL DEFAULT 0,
            synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(company_id, as_on_date, ledger_name)
        );
        CREATE INDEX IF NOT EXISTS idx_bs_company_date ON balance_sheet(company_id, as_on_date);

        -- ============================================
        -- VOUCHERS / DAYBOOK (Transaction Level)
        -- ============================================
        CREATE TABLE IF NOT EXISTS vouchers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
            date DATE NOT NULL,
            voucher_type TEXT NOT NULL,
            voucher_number TEXT,
            ledger_name TEXT,
            amount REAL NOT NULL,
            party_name TEXT,
            narration TEXT,
            sync_month TEXT,
            synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_vch_company_date ON vouchers(company_id, date);
        CREATE INDEX IF NOT EXISTS idx_vch_type ON vouchers(voucher_type);
        CREATE INDEX IF NOT EXISTS idx_vch_ledger ON vouchers(ledger_name);
        CREATE INDEX IF NOT EXISTS idx_vch_sync_month ON vouchers(sync_month);

        -- ============================================
        -- STOCK SUMMARY (Monthly Snapshots)
        -- ============================================
        CREATE TABLE IF NOT EXISTS stock_summary (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
            period_from DATE NOT NULL,
            period_to DATE NOT NULL,
            item_name TEXT NOT NULL,
            stock_group TEXT,
            opening_qty REAL DEFAULT 0,
            opening_value REAL DEFAULT 0,
            inward_qty REAL DEFAULT 0,
            inward_value REAL DEFAULT 0,
            outward_qty REAL DEFAULT 0,
            outward_value REAL DEFAULT 0,
            closing_qty REAL DEFAULT 0,
            closing_value REAL DEFAULT 0,
            synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(company_id, period_from, period_to, item_name)
        );

        -- ============================================
        -- BILLS OUTSTANDING (Periodic Snapshots)
        -- ============================================
        CREATE TABLE IF NOT EXISTS bills_outstanding (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
            as_on_date DATE NOT NULL,
            nature TEXT CHECK (nature IN ('receivable', 'payable')),
            bill_date DATE,
            reference_number TEXT,
            outstanding_amount REAL DEFAULT 0,
            party_name TEXT,
            overdue_days INTEGER DEFAULT 0,
            synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_bills_company ON bills_outstanding(company_id, as_on_date, nature);

        -- ============================================
        -- SYNC LOG (Track extraction progress)
        -- ============================================
        CREATE TABLE IF NOT EXISTS sync_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
            report_type TEXT NOT NULL,
            period_from DATE,
            period_to DATE,
            row_count INTEGER DEFAULT 0,
            status TEXT CHECK (status IN ('running', 'success', 'error', 'partial')),
            error_message TEXT,
            started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME,
            duration_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_sync_log_company ON sync_log(company_id, report_type);
    `);

    // Insert default settings
    const insertSetting = db.prepare(
        'INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)'
    );
    const defaults = {
        'tally_host': 'localhost',
        'tally_port': '9000',
        'sync_interval_minutes': '60',
        'auto_sync': 'true',
        'dashboard_port': '3456',
        'dashboard_password': '',
        'lan_access': 'false',
        'theme': 'dark'
    };
    for (const [key, value] of Object.entries(defaults)) {
        insertSetting.run(key, value);
    }

    console.log('Database schema initialized successfully');
}

function runMigrations(db) {
    // Migration M1: Deduplicate vouchers (keep lowest rowid per unique entry)
    const dupeCount = db.prepare(
        "SELECT COUNT(*) as n FROM vouchers WHERE rowid NOT IN (SELECT MIN(rowid) FROM vouchers GROUP BY company_id, date, voucher_type, COALESCE(voucher_number,''), COALESCE(ledger_name,''), amount)"
    ).get().n;
    if (dupeCount > 0) {
        console.log(`[Migration] Removing ${dupeCount} duplicate voucher rows...`);
        db.prepare(
            "DELETE FROM vouchers WHERE rowid NOT IN (SELECT MIN(rowid) FROM vouchers GROUP BY company_id, date, voucher_type, COALESCE(voucher_number,''), COALESCE(ledger_name,''), amount)"
        ).run();
        console.log('[Migration] Voucher deduplication complete.');
    }

    // Migration M2: Unique index on vouchers to prevent future duplicates
    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_vch_unique
        ON vouchers(company_id, date, voucher_type, COALESCE(voucher_number,''), COALESCE(ledger_name,''), amount)
    `);
}

module.exports = { initDatabase, getDbPath, DB_DIR };
