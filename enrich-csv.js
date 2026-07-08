/**
 * enrich-csv.js
 *
 * One-time script: reads an existing asset-map CSV, checks each asset path
 * against AEM to detect Content Fragments (jcr:content/data.json has cq:model),
 * and writes an isCF column back into the same CSV.
 *
 * Usage:
 *   node enrich-csv.js <envName> <aemUrl> <username> <password>
 *
 * Example:
 *   node enrich-csv.js dev https://author-p157365-e1665873.adobeaemcloud.com admin secret
 */

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const { parse }     = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const CONCURRENCY = 20;
const httpsAgent  = new (require('https').Agent)({ rejectUnauthorized: false });

// ── Args ──────────────────────────────────────────────────────────────────────
const [,, envName, aemUrl, username, password] = process.argv;

if (!envName || !aemUrl || !username || !password) {
  console.error('Usage: node enrich-csv.js <envName> <aemUrl> <username> <password>');
  console.error('Example: node enrich-csv.js dev https://author-p157365-e1665873.adobeaemcloud.com admin secret');
  process.exit(1);
}

const slug    = envName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
const csvFile = path.join(__dirname, 'data', `asset-map-${slug}.csv`);

if (!fs.existsSync(csvFile)) {
  console.error(`CSV not found: ${csvFile}`);
  process.exit(1);
}

// ── CF detection via jcr:content/data.json ────────────────────────────────────
function isCfAsset(assetPath) {
  return new Promise((resolve) => {
    const url  = `${aemUrl.replace(/\/$/, '')}${assetPath}/jcr:content/data.json`;
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    const lib  = url.startsWith('https') ? https : http;
    const opts = {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      ...(url.startsWith('https') ? { agent: httpsAgent } : {}),
    };

    const req = lib.get(url, opts, res => {
      if (res.statusCode === 404) { res.resume(); return resolve(false); }
      if (res.statusCode === 401) { res.resume(); return resolve(false); }
      if (res.statusCode !== 200) { res.resume(); return resolve(false); }

      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          resolve(typeof json['cq:model'] === 'string' && json['cq:model'].length > 0);
        } catch {
          resolve(false);
        }
      });
    });

    req.on('error', () => resolve(false));
    req.setTimeout(15000, () => { req.destroy(); resolve(false); });
  });
}

// ── Batch runner ──────────────────────────────────────────────────────────────
async function processBatch(rows) {
  return Promise.all(rows.map(async row => {
    const cf = await isCfAsset(row.path);
    return { ...row, isCF: cf ? 'true' : 'false' };
  }));
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\nEnriching: ${csvFile}`);
  console.log(`AEM      : ${aemUrl}`);
  console.log(`Env      : ${envName}\n`);

  const rows = parse(fs.readFileSync(csvFile, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
  });

  console.log(`Total rows: ${rows.length}`);

  // If isCF column already exists, ask before overwriting
  if (rows[0] && 'isCF' in rows[0]) {
    console.log('⚠  isCF column already exists — re-enriching all rows.\n');
  }

  const enriched = [];
  let done = 0, cfCount = 0;
  const startTime = Date.now();

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch   = rows.slice(i, i + CONCURRENCY);
    const results = await processBatch(batch);

    for (const r of results) {
      enriched.push(r);
      if (r.isCF === 'true') cfCount++;
    }

    done += batch.length;
    const pct     = Math.round((done / rows.length) * 100);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    process.stdout.write(`\r  ${done} / ${rows.length} (${pct}%)  |  CFs found: ${cfCount}  |  ${elapsed}s elapsed   `);
  }

  console.log('\n');

  // Write back — preserve all existing columns, append isCF at the end
  const existingCols = Object.keys(rows[0]).filter(k => k !== 'isCF');
  const columns = [
    ...existingCols.map(key => ({ key, header: key })),
    { key: 'isCF', header: 'isCF' },
  ];

  const csv = stringify(enriched, { header: true, columns });
  fs.writeFileSync(csvFile, csv, 'utf8');

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✔  Done in ${elapsed}s`);
  console.log(`   Total assets : ${rows.length}`);
  console.log(`   Content Frags: ${cfCount}`);
  console.log(`   Regular assets: ${rows.length - cfCount}`);
  console.log(`   CSV saved    : ${csvFile}\n`);
})();
