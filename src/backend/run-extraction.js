/**
 * TallyVision - Standalone Extraction Runner
 * Run: node run-extraction.js --company "MyCompany" --from 2025-04-01 --to 2026-03-31
 */

const { initDatabase } = require('./db/setup');
const { DataExtractor } = require('./extractors/data-extractor');

async function main() {
    // Parse CLI args
    const args = process.argv.slice(2);
    const getArg = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

    const companyName = getArg('--company') || getArg('-c');
    const fromDate = getArg('--from') || '2025-04-01';
    const toDate = getArg('--to') || '2026-03-31';
    const host = getArg('--host') || 'localhost';
    const port = parseInt(getArg('--port') || '9000');

    if (!companyName) {
        console.log('\nUsage: node run-extraction.js --company "Company Name" [options]');
        console.log('\nOptions:');
        console.log('  --company, -c   Company name as shown in Tally (required)');
        console.log('  --from          Start date YYYY-MM-DD (default: 2025-04-01)');
        console.log('  --to            End date YYYY-MM-DD (default: 2026-03-31)');
        console.log('  --host          Tally host (default: localhost)');
        console.log('  --port          Tally port (default: 9000)');
        console.log('\nExample:');
        console.log('  node run-extraction.js --company "ABC Traders" --from 2024-04-01 --to 2025-03-31\n');
        process.exit(1);
    }

    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║         TallyVision Data Extraction          ║');
    console.log('╚══════════════════════════════════════════════╝\n');
    console.log(`  Company : ${companyName}`);
    console.log(`  Period  : ${fromDate} to ${toDate}`);
    console.log(`  Tally   : ${host}:${port}`);
    console.log('');

    // Init database
    const db = initDatabase();

    // Upsert company
    db.prepare('INSERT OR IGNORE INTO companies (name) VALUES (?)').run(companyName);
    const company = db.prepare('SELECT * FROM companies WHERE name = ?').get(companyName);

    // Create extractor with console progress
    const extractor = new DataExtractor(db, {
        host, port,
        onProgress: (p) => {
            const prog = p.progress ? ` [${p.progress}%]` : '';
            const icon = p.status === 'done' ? '✅' : p.status === 'error' ? '❌' : '⏳';
            console.log(`  ${icon} ${p.message || p.step}${prog}`);
        }
    });

    // Check Tally connection first
    console.log('  Checking Tally connection...');
    const alive = await extractor.tally.ping();
    if (!alive) {
        console.error('\n  ❌ Cannot connect to Tally at ' + host + ':' + port);
        console.error('     Make sure Tally is running and a company is open.\n');
        process.exit(1);
    }
    console.log('  ✅ Tally is reachable\n');

    // Run full sync
    console.log('  Starting extraction (this may take several minutes)...\n');
    const results = await extractor.runFullSync(company.id, companyName, fromDate, toDate);

    console.log('\n  ══════════════════════════════════════════');
    console.log('  EXTRACTION RESULTS');
    console.log('  ══════════════════════════════════════════');
    console.log(`  Duration      : ${Math.round(results.durationMs / 1000)} seconds`);
    console.log(`  Status        : ${results.success ? '✅ SUCCESS' : '⚠️ PARTIAL (some errors)'}`);
    if (results.counts) {
        for (const [key, val] of Object.entries(results.counts)) {
            if (val !== undefined) console.log(`  ${key.padEnd(15)}: ${val} rows`);
        }
    }
    if (results.errors.length > 0) {
        console.log('\n  Errors:');
        results.errors.forEach(e => console.log(`    ❌ ${e}`));
    }
    console.log('\n  Dashboard: http://localhost:3456');
    console.log('  Start server: node src/backend/server.js\n');

    process.exit(0);
}

main().catch(err => {
    console.error('\n  ❌ Fatal error:', err.message);
    process.exit(1);
});
