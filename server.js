const express             = require('express');
const { randomUUID }      = require('crypto');
const { spawn }           = require('child_process');
const axios               = require('axios');
const chromeLauncher      = require('chrome-launcher');
// lighthouse v10+ is ESM-only — load once via dynamic import and cache
let _lighthouse;
async function getLighthouse() {
  if (!_lighthouse) ({ default: _lighthouse } = await import('lighthouse'));
  return _lighthouse;
}
const AdmZip  = require('adm-zip');
const JSZip   = require('jszip');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { parse }     = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const multer  = require('multer');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Shared setup ────────────────────────────────────────────────────────────
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

const DATA_DIR   = path.join(__dirname, 'data');
const OUTPUT_DIR = path.join(__dirname, 'output');
if (!fs.existsSync(DATA_DIR))   fs.mkdirSync(DATA_DIR,   { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// SSE helper (meta tool — standard SSE event format)
function sseWrite(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ══════════════════════════════════════════════════════════════════════════════
// PAGE METADATA TOOL  (/api/meta/*)
// ══════════════════════════════════════════════════════════════════════════════

// ─── File persistence helpers ─────────────────────────────────────────────────
const MAPPING_FILE = path.join(__dirname, 'mapping.json');
const CONFIG_FILE  = path.join(__dirname, 'config.json');

function loadMapping() {
  try {
    if (fs.existsSync(MAPPING_FILE)) {
      return JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('Could not read mapping.json:', e.message);
  }
  return [];
}

function saveMapping(mapping) {
  fs.writeFileSync(MAPPING_FILE, JSON.stringify(mapping, null, 2), 'utf8');
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('Could not read config.json:', e.message);
  }
  return null;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// ─── In-memory state ─────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  source: {
    host: 'https://34.225.5.238',
    username: 'migration1',
    password: 'migration',
    rootPath: '/content/abbvie-com2/us/en'
  },
  target: {
    host: '',
    username: '',
    password: '',
    rootPath: ''
  }
};

let appConfig      = loadConfig() || DEFAULT_CONFIG;
let propertyMapping = loadMapping();
let discoveredPages = [];
let discoveredProps = [];

const EXCLUDED = new Set([
  'jcr:primaryType', 'jcr:mixinTypes', 'jcr:uuid', 'jcr:versionHistory',
  'jcr:baseVersion', 'jcr:isCheckedOut', 'jcr:predecessors',
  'jcr:created', 'jcr:createdBy', 'jcr:lastModified', 'jcr:lastModifiedBy',
  'cq:lastModified', 'cq:lastModifiedBy',
  'cq:contextHubPath', 'cq:contextHubSegmentsPath',
  'cq:lastReplicated', 'cq:lastReplicatedBy', 'cq:lastReplicationAction',
  'cq:template', 'sling:resourceType'
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeClient(cfg) {
  return axios.create({
    baseURL: cfg.host,
    auth: { username: cfg.username, password: cfg.password },
    httpsAgent,
    timeout: 30000
  });
}

function transformAemTagToEds(tag) {
  const colonIdx = tag.indexOf(':');
  if (colonIdx === -1) return tag;
  const ns   = tag.slice(0, colonIdx);
  const rest = tag.slice(colonIdx + 1);
  return `corporate:${ns}/${rest}`;
}

function transformDamPath(val) {
  return String(val).replace('/content/dam/', '/content/dam/corporate/');
}

// Idempotent /corporate insertion — never doubles it if already present.
function insertCorporate(val) {
  const s = String(val);
  return s.includes('/content/dam/corporate/') ? s : s.replace('/content/dam/', '/content/dam/corporate/');
}

// DAM path → DM Open API URL: insert /corporate, look the path up in the asset-map
// CSV, and return its openApiUrl. Falls back to the /corporate path if not found.
function transformDamToDm(val, damPathMap) {
  const corp      = insertCorporate(val);
  const lookupKey = corp.split('?')[0].split('#')[0];   // strip query/fragment for the CSV key
  return damPathMap?.get(lookupKey) || corp;
}

// Build path → openApiUrl map from an environment's asset-map CSV (or null if none).
function loadDamPathMap(envName) {
  const file = csvPath(envName || 'default');
  if (!fs.existsSync(file)) return null;
  const rows = parse(fs.readFileSync(file, 'utf8'), { columns: true, skip_empty_lines: true });
  return new Map(rows.filter(r => r.path && r.openApiUrl).map(r => [r.path, r.openApiUrl]));
}

// Append a constant/custom EDS property (literal value + AEM value type) to a
// URLSearchParams (Sling POST). Multi-value splits the value on commas.
function appendConstant(params, eds, value, valueType) {
  const t = valueType || 'String';
  if (t === 'String[]') {
    const vals = String(value).split(',').map(s => s.trim()).filter(Boolean);
    vals.forEach(v => params.append(eds, v));
    params.append(`${eds}@TypeHint`, 'String[]');
  } else {
    params.append(eds, String(value));
    if (t !== 'String') params.append(`${eds}@TypeHint`, t);   // Boolean / Date / Long / Double
  }
}

// ctx = { damPathMap } — required only for the 'dam-to-dm-openapi' transform
function applyTransform(transform, val, ctx) {
  if (!transform) return val;
  if (transform === 'aem-tag-to-eds') {
    return Array.isArray(val)
      ? val.map(transformAemTagToEds)
      : transformAemTagToEds(String(val));
  }
  if (transform === 'dam-path-to-eds') {
    return Array.isArray(val) ? val.map(transformDamPath) : transformDamPath(val);
  }
  if (transform === 'dam-to-dm-openapi') {
    const map = ctx?.damPathMap;
    return Array.isArray(val) ? val.map(v => transformDamToDm(v, map)) : transformDamToDm(val, map);
  }
  return val;
}

function normalizeValue(v) {
  if (Array.isArray(v)) return v.join(' | ');
  if (typeof v === 'object' && v !== null) return null;
  return String(v);
}

// ─── Config ───────────────────────────────────────────────────────────────────
app.get('/api/meta/config', (req, res) => res.json(appConfig));

app.post('/api/meta/config', (req, res) => {
  appConfig = req.body;
  saveConfig(appConfig);
  res.json({ ok: true });
});

// ─── Mapping ──────────────────────────────────────────────────────────────────
app.get('/api/meta/mapping', (req, res) => res.json(propertyMapping));

app.post('/api/meta/mapping', (req, res) => {
  propertyMapping = req.body;
  saveMapping(propertyMapping);
  res.json({ ok: true });
});

// ─── Discovered pages (cached) ───────────────────────────────────────────────
app.get('/api/meta/pages', (req, res) => {
  res.json({ pages: discoveredPages, properties: discoveredProps });
});

// ─── Discovery — SSE stream ───────────────────────────────────────────────────
app.get('/api/meta/discover', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const client = makeClient(appConfig.source);

    sseWrite(res, { type: 'status', message: 'Fetching page list from QueryBuilder...' });

    const qbRes = await client.get('/bin/querybuilder.json', {
      params: {
        path: appConfig.source.rootPath,
        type: 'cq:Page',
        'p.limit': -1,
        'p.hits': 'selective',
        'p.properties': 'jcr:path'
      }
    });

    const paths = (qbRes.data.hits || []).map(h => h['jcr:path']);
    sseWrite(res, { type: 'total', total: paths.length });

    const allPropsSet = new Set();
    discoveredPages = [];
    let processed = 0;
    const CONCURRENCY = 10;

    for (let i = 0; i < paths.length; i += CONCURRENCY) {
      const batch = paths.slice(i, i + CONCURRENCY);

      const results = await Promise.allSettled(
        batch.map(async (pagePath) => {
          const r = await client.get(`${pagePath}/jcr:content.1.json`);
          const props = {};
          for (const [k, v] of Object.entries(r.data)) {
            if (EXCLUDED.has(k)) continue;
            const normalized = normalizeValue(v);
            if (normalized !== null) {
              props[k] = normalized;
              allPropsSet.add(k);
            }
          }
          return { path: pagePath, properties: props };
        })
      );

      for (const result of results) {
        processed++;
        if (result.status === 'fulfilled') {
          discoveredPages.push(result.value);
        }
      }

      sseWrite(res, { type: 'progress', done: processed, total: paths.length });
    }

    discoveredProps = [...allPropsSet].sort();
    sseWrite(res, {
      type: 'complete',
      total: discoveredPages.length,
      properties: discoveredProps
    });

  } catch (err) {
    sseWrite(res, { type: 'error', message: err.message });
  }

  res.end();
});

// ─── Verify target pages exist on EDS ────────────────────────────────────────
app.post('/api/meta/verify-targets', async (req, res) => {
  const { targets } = req.body;
  const targetClient = makeClient(appConfig.target);
  const CONCURRENCY = 10;
  const results = [];

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async ({ sourcePath, targetPath }) => {
        try {
          await targetClient.head(`${targetPath}.1.json`);
          return { sourcePath, targetPath, exists: true };
        } catch (err) {
          const status = err.response?.status;
          return { sourcePath, targetPath, exists: status !== 404 && status !== undefined ? true : false };
        }
      })
    );
    batchResults.forEach(r => results.push(r.status === 'fulfilled' ? r.value : { exists: false }));
  }

  res.json(results);
});

// ─── Debug: preview what will be sent for a single page ──────────────────────
app.post('/api/meta/debug-update', async (req, res) => {
  const { pagePath, assetEnv } = req.body;
  const mapping = loadMapping();
  const damPathMap = mapping.some(m => m.transform === 'dam-to-dm-openapi') ? loadDamPathMap(assetEnv) : null;

  try {
    const sourceClient = makeClient(appConfig.source);
    const r = await sourceClient.get(`${pagePath}/jcr:content.1.json`);
    const pageProps = r.data;

    const targetPath = pagePath.replace(appConfig.source.rootPath, appConfig.target.rootPath);
    const params = {};

    for (const { aem, eds, transform, value, valueType } of mapping) {
      if (!eds) continue;
      if (aem) {
        if (pageProps[aem] !== undefined) {
          const val = applyTransform(transform, pageProps[aem], { damPathMap });
          params[eds] = Array.isArray(val) ? val : String(val);
          if (Array.isArray(val)) params[`${eds}@TypeHint`] = 'String[]';
        }
      } else if (value !== undefined && value !== '') {
        // Constant / custom property (debug preview representation)
        params[eds] = valueType === 'String[]'
          ? String(value).split(',').map(s => s.trim()).filter(Boolean)
          : String(value);
        if (valueType && valueType !== 'String') params[`${eds}@TypeHint`] = valueType;
      }
    }

    res.json({
      sourcePath: pagePath,
      targetHost: appConfig.target.host,
      targetPath: `${targetPath}/jcr:content`,
      targetUser: appConfig.target.username,
      targetRootConfigured: !!appConfig.target.rootPath,
      propsToWrite: params,
      mappingCount: mapping.length,
      sourcePropsFound: Object.keys(pageProps).filter(k => mapping.some(m => m.aem === k))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Resolve DAM paths → DM Open API URLs (for the client-side Preview) ──────
app.post('/api/meta/resolve-dm', express.json({ limit: '2mb' }), (req, res) => {
  const { env, values } = req.body;
  const map = loadDamPathMap(env);
  if (!map) return res.status(400).json({ error: `No asset-map CSV found for environment "${env || '(none)'}". Build it in the Image/Asset tool first.` });
  const resolve = v => transformDamToDm(v, map);
  const resolved = (values || []).map(v => (Array.isArray(v) ? v.map(resolve) : resolve(String(v))));
  res.json({ resolved });
});

// ─── Bulk Update — SSE stream for progress ───────────────────────────────────
let updateJob     = { running: false, total: 0, done: 0, errors: 0, skipped: 0, log: [] };
let updateClients = [];

app.get('/api/meta/update/progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  updateClients.push(res);
  sseWrite(res, updateJob);
  req.on('close', () => {
    updateClients = updateClients.filter(c => c !== res);
  });
});

function broadcastUpdate() {
  updateClients.forEach(c => sseWrite(c, updateJob));
}

app.post('/api/meta/update/start', async (req, res) => {
  const { selectedPaths, assetEnv } = req.body;

  if (updateJob.running) {
    return res.status(409).json({ error: 'Update already in progress' });
  }

  const mapping = loadMapping();
  if (!mapping.length) {
    return res.status(400).json({ error: 'mapping.json is empty. Add mappings before running update.' });
  }

  // Load the asset-map CSV once if any mapping resolves to a DM Open API URL.
  let damPathMap = null;
  if (mapping.some(m => m.transform === 'dam-to-dm-openapi')) {
    damPathMap = loadDamPathMap(assetEnv);
    if (!damPathMap) {
      return res.status(400).json({ error: `A mapping uses "DAM → DM Open API URL" but no asset-map CSV exists for environment "${assetEnv || '(none selected)'}". Build it in the Image/Asset tool first.` });
    }
  }

  updateJob = { running: true, total: selectedPaths.length, done: 0, errors: 0, skipped: 0, log: [] };
  res.json({ ok: true, total: selectedPaths.length });
  broadcastUpdate();

  const sourceClient = makeClient(appConfig.source);
  const targetClient = makeClient(appConfig.target);
  const CONCURRENCY  = 5;

  async function updateOnePage(pagePath) {
    try {
      const r = await sourceClient.get(`${pagePath}/jcr:content.1.json`);
      const pageProps = r.data;

      const targetPath = pagePath.replace(appConfig.source.rootPath, appConfig.target.rootPath);
      const params = new URLSearchParams();

      for (const { aem, eds, transform, value, valueType, typeHint } of mapping) {
        if (!eds) continue;
        if (aem) {
          if (pageProps[aem] !== undefined) {
            const val = applyTransform(transform, pageProps[aem], { damPathMap });
            if (Array.isArray(val)) {
              // Array value: always multi-value regardless of typeHint
              val.forEach(v => params.append(eds, v));
              params.append(`${eds}@TypeHint`, typeHint || 'String[]');
            } else if (typeHint === 'String[]') {
              // Single string but user forced String[] — AEM serialised a one-element multi-value as plain string
              params.append(eds, String(val));
              params.append(`${eds}@TypeHint`, 'String[]');
            } else if (typeHint) {
              // Any other forced type hint (Boolean, Long, etc.)
              params.append(eds, String(val));
              params.append(`${eds}@TypeHint`, typeHint);
            } else {
              params.append(eds, String(val));
            }
          }
        } else if (value !== undefined && value !== '') {
          appendConstant(params, eds, value, valueType);   // custom constant property
        }
      }

      if ([...params].length === 0) {
        updateJob.skipped++;
        updateJob.log.push({ pagePath, status: 'skipped', message: 'No mapped properties had values on this page' });
      } else {
        await targetClient.post(`${targetPath}/jcr:content`, params.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        updateJob.log.push({ pagePath, status: 'success' });
      }
    } catch (err) {
      updateJob.errors++;
      const errMsg = err.response?.data
        ? (typeof err.response.data === 'object' ? JSON.stringify(err.response.data) : err.response.data)
        : err.message;
      updateJob.log.push({ pagePath, status: 'error', message: errMsg });
    } finally {
      updateJob.done++;
      broadcastUpdate();
    }
  }

  (async () => {
    for (let i = 0; i < selectedPaths.length; i += CONCURRENCY) {
      const batch = selectedPaths.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(updateOnePage));
    }
    updateJob.running = false;
    broadcastUpdate();
  })();
});

// ─── Export discovered data as CSV ───────────────────────────────────────────
app.get('/api/meta/export/csv', (req, res) => {
  if (!discoveredPages.length) {
    return res.status(400).json({ error: 'No pages discovered yet' });
  }

  const headers = ['pagePath', ...discoveredProps];
  const rows = discoveredPages.map(page => {
    return headers.map(h => {
      const val = h === 'pagePath' ? page.path : (page.properties[h] ?? '');
      return `"${String(val).replace(/"/g, '""')}"`;
    }).join(',');
  });

  const csv = [headers.join(','), ...rows].join('\r\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="page-properties.csv"');
  res.send(csv);
});

// ─── Analyse a single property across all discovered pages ───────────────────
app.get('/api/meta/analysis/property', (req, res) => {
  const prop = req.query.prop;
  if (!prop) return res.status(400).json({ error: 'Missing ?prop= query parameter' });
  if (!discoveredPages.length) return res.status(400).json({ error: 'No pages discovered yet — run discovery first.' });

  const withProp   = [];
  const withoutProp = [];
  const valueCounts = new Map();

  for (const page of discoveredPages) {
    if (prop in page.properties) {
      withProp.push(page.path);
      const val = page.properties[prop];
      valueCounts.set(val, (valueCounts.get(val) || 0) + 1);
    } else {
      withoutProp.push(page.path);
    }
  }

  const valueBreakdown = [...valueCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, count }));

  res.json({
    property: prop,
    totalPages: discoveredPages.length,
    withProperty: withProp.length,
    withoutProperty: withoutProp.length,
    valueBreakdown,
    pagesWithProperty: withProp,
    pagesWithoutProperty: withoutProp,
  });
});

// ─── Export update log as CSV ─────────────────────────────────────────────────
app.get('/api/meta/export/log', (req, res) => {
  if (!updateJob.log.length) {
    return res.status(400).json({ error: 'No update log available' });
  }

  const headers = ['pagePath', 'status', 'message'];
  const rows = updateJob.log.map(entry =>
    headers.map(h => `"${String(entry[h] ?? '').replace(/"/g, '""')}"`).join(',')
  );

  const csv = [headers.join(','), ...rows].join('\r\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="update-log.csv"');
  res.send(csv);
});

// ══════════════════════════════════════════════════════════════════════════════
// IMAGE / ASSET TOOL  (/api/image/*)
// ══════════════════════════════════════════════════════════════════════════════

const SITE_CONFIG_PATH = path.join(__dirname, 'site.config.json');

const envSlug  = name => (name || 'default').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
const csvPath  = envName => path.join(DATA_DIR,   `asset-map-${envSlug(envName)}.csv`);
const configPath = envName => path.join(DATA_DIR, `config-${envSlug(envName)}.json`);

// Previous-build reference CSVs live in data-old/ (same per-env filename). A fresh
// crawl can lose dam:scene7Name/dam:scene7File on reprocessed assets, so build-csv
// backfills those two columns from here for assets that match by path.
const DATA_OLD_DIR = path.join(__dirname, 'data-old');
const oldCsvPath   = envName => path.join(DATA_OLD_DIR, `asset-map-${envSlug(envName)}.csv`);

// Build a path → { scene7Name, scene7File } map from the env's data-old CSV.
// Returns null if the reference file is missing or unreadable.
function loadOldScene7Map(envName) {
  const file = oldCsvPath(envName);
  if (!fs.existsSync(file)) return null;
  try {
    const oldRows = parse(fs.readFileSync(file, 'utf8'), { columns: true, skip_empty_lines: true });
    const map = new Map();
    for (const r of oldRows) {
      if (r.path && (r.scene7Name || r.scene7File)) {
        map.set(r.path, { scene7Name: r.scene7Name || '', scene7File: r.scene7File || '' });
      }
    }
    return map;
  } catch {
    return null;
  }
}

function loadSiteConfig() {
  try {
    if (fs.existsSync(SITE_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(SITE_CONFIG_PATH, 'utf8'));
      if (Array.isArray(raw.environments)) return raw;
      return { environments: [{ name: 'Default', ...raw }] };
    }
  } catch { /* ignore */ }
  return { environments: [] };
}

// ── DM Open API URL builder ────────────────────────────────────────────────────
// Image assets are delivered via the optimized path (…/as/name.ext); everything
// else (PDF and other documents) must use the ORIGINAL binary path (…/original/as/name.ext).
const DM_IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'tif', 'tiff', 'bmp', 'avif', 'ico', 'heic', 'heif']);
function dmDeliverySegment(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return DM_IMAGE_EXT.has(ext) ? 'as' : 'original/as';
}
function buildDmOpenApiUrl(host, uuid, filename) {
  return `https://${host}/adobe/assets/urn:aaid:aem:${uuid}/${dmDeliverySegment(filename)}/${filename}`;
}
// Ensure a PDF (non-image) DM URL uses the /original/as/ path — corrects older CSVs
// that were generated with the plain /as/ path, without needing a rebuild.
function ensureOriginalDelivery(url) {
  if (!/^https?:\/\//i.test(url) || url.includes('/original/as/')) return url;
  return url.replace(/(\/adobe\/assets\/[^/]+)\/as\//, '$1/original/as/');
}

// ── Site config ───────────────────────────────────────────────────────────────
app.get('/api/image/site-config', (req, res) => {
  res.json(loadSiteConfig());
});

// ── CSV status ────────────────────────────────────────────────────────────────
app.get('/api/image/csv-status', (req, res) => {
  const { environments = [] } = loadSiteConfig();
  const statuses = environments.map(env => {
    // The CSV is what every consumer (link-checker fix/analyze, image update-zip) actually
    // reads — the config-<env>.json sidecar only carries build metadata (lastBuilt/count)
    // and is written by build-csv. A CSV placed in data/ by any other means (manual copy,
    // restored from data-old, etc.) is still perfectly usable even without that sidecar,
    // so its absence must not mask a real, usable CSV.
    if (!fs.existsSync(csvPath(env.name))) return { name: env.name, exists: false };
    const cp = configPath(env.name);
    if (fs.existsSync(cp)) {
      try {
        const config = JSON.parse(fs.readFileSync(cp, 'utf8'));
        return { name: env.name, exists: true, ...config };
      } catch { /* corrupt sidecar — fall through to bare exists */ }
    }
    return { name: env.name, exists: true };
  });
  res.json({ statuses });
});

// ── Build CSV ─────────────────────────────────────────────────────────────────
app.post('/api/image/build-csv', async (req, res) => {
  const { aemUrl, username, password, damRoot, dmHost, envName, verifyScene7, s7Host, s7Root,
          recoverFromSource, s7SourceHost, s7SourceUser, s7SourcePass } = req.body;

  if (!aemUrl || !username || !password || !damRoot || !dmHost) {
    return res.json({ success: false, error: 'All fields are required.' });
  }

  const doVerify = verifyScene7 !== false;   // on by default; send verifyScene7:false to skip

  const ENV_CSV_PATH    = csvPath(envName || 'default');
  const ENV_CONFIG_PATH = configPath(envName || 'default');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = obj => res.write(JSON.stringify(obj) + '\n');
  const log  = msg => { send({ log: msg }); console.log('[build-csv]', msg); };

  try {
    log(`Starting asset query for: ${damRoot}`);
    const assets = await queryAllAssets(aemUrl, username, password, damRoot, log);
    log(`Query complete — ${assets.length} assets found. Building CSV...`);

    if (assets.length > 0) {
      log(`DEBUG first asset keys: ${JSON.stringify(Object.keys(assets[0]))}`);
      log(`DEBUG first asset sample: ${JSON.stringify(assets[0]).substring(0, 400)}`);
    }

    const cleanHost = dmHost.replace(/^https?:\/\//, '').replace(/\/$/, '');

    const rows = assets.map(asset => {
      const jcrPath = asset['jcr:path'] || '';
      const uuid    = (asset['jcr:uuid'] || '').trim();
      const scene7Name =
        asset['jcr:content']?.metadata?.['dam:scene7Name'] ||
        asset['jcr:content/metadata/dam:scene7Name'] || '';
      const scene7File =
        asset['jcr:content']?.metadata?.['dam:scene7File'] ||
        asset['jcr:content/metadata/dam:scene7File'] || '';
      const damStatus = (
        asset['jcr:content']?.metadata?.['dam:status'] ||
        asset['jcr:content/metadata/dam:status'] || ''
      ).trim().toLowerCase();
      const cfFlag = asset['jcr:content']?.contentFragment ?? asset['jcr:content/contentFragment'];
      const isCF   = cfFlag === true || cfFlag === 'true';
      const filename   = path.posix.basename(jcrPath);
      // Content fragments are not deliverable binaries — never build a DM Open API URL
      // for them; keep the DAM path so downstream tools leave CF references unchanged.
      const openApiUrl = (!isCF && uuid && damStatus === 'approved')
        ? buildDmOpenApiUrl(cleanHost, uuid, filename)
        : jcrPath;
      return { path: jcrPath, uuid, scene7Name, scene7File, damStatus, openApiUrl, isCF: isCF ? 'true' : 'false' };
    });

    // ── Backfill Scene7 fields from the data-old reference CSV ──────────────────
    // Fill-only-when-empty: a value produced by the fresh crawl is never overwritten;
    // old data only fills gaps for assets that exist in both (matched by path).
    const oldS7 = loadOldScene7Map(envName || 'default');
    if (oldS7) {
      let matched = 0, filledName = 0, filledFile = 0;
      for (const row of rows) {
        const prev = oldS7.get(row.path);
        if (!prev) continue;
        matched++;
        if (!row.scene7Name && prev.scene7Name) { row.scene7Name = prev.scene7Name; filledName++; }
        if (!row.scene7File && prev.scene7File) { row.scene7File = prev.scene7File; filledFile++; }
      }
      log(`Scene7 backfill from data-old: ${matched} common asset(s) — filled scene7Name ${filledName}, scene7File ${filledFile}.`);
    } else {
      log(`Scene7 backfill: no reference CSV at data-old/asset-map-${envSlug(envName || 'default')}.csv — skipped.`);
    }

    // ── Recover Scene7 from the legacy source AEM (authoritative — runs first) ──
    if (recoverFromSource !== false) {
      await recoverScene7FromSource(rows, log, {
        host:     s7SourceHost || appConfig?.source?.host,
        username: s7SourceUser || appConfig?.source?.username,
        password: s7SourcePass || appConfig?.source?.password,
      });
    } else {
      log('Scene7 source recovery: skipped (recoverFromSource=false).');
    }

    // ── Recover remaining image assets by filename + live Scene7 confirm (fallback) ──
    if (doVerify) {
      await verifyScene7ForRows(rows, log, { host: s7Host, root: s7Root });
    } else {
      log('Scene7 recovery: skipped (verifyScene7=false).');
    }

    const statusCounts = rows.reduce((acc, r) => {
      acc[r.damStatus || '(empty)'] = (acc[r.damStatus || '(empty)'] || 0) + 1;
      return acc;
    }, {});
    log(`damStatus distribution: ${JSON.stringify(statusCounts)}`);
    const dmUrlCount = rows.filter(r => r.openApiUrl.startsWith('https://')).length;
    log(`DM Open API URLs generated: ${dmUrlCount} / ${rows.length}`);
    const cfCount = rows.filter(r => r.isCF === 'true').length;
    log(`Content fragments detected: ${cfCount} (kept as DAM paths, not converted to DM URLs)`);

    const csv = stringify(rows, {
      header: true,
      columns: [
        { key: 'path',        header: 'path'        },
        { key: 'uuid',        header: 'uuid'        },
        { key: 'scene7Name',  header: 'scene7Name'  },
        { key: 'scene7File',  header: 'scene7File'  },
        { key: 'damStatus',   header: 'damStatus'   },
        { key: 'openApiUrl',  header: 'openApiUrl'  },
        { key: 'isCF',        header: 'isCF'        },
      ],
    });

    fs.writeFileSync(ENV_CSV_PATH, csv, 'utf8');
    fs.writeFileSync(ENV_CONFIG_PATH, JSON.stringify(
      { envName: envName || 'default', aemUrl, damRoot, dmHost,
        lastBuilt: new Date().toISOString(), count: rows.length },
      null, 2
    ), 'utf8');

    log(`CSV saved — ${rows.length} assets written.`);
    send({ done: true, success: true, count: rows.length });
  } catch (err) {
    log(`Error: ${err.message}`);
    send({ done: true, success: false, error: err.message });
  }
  res.end();
});

// ── Scene7 → Open API modifier translator ─────────────────────────────────────
const S7_PARAM_MAP = {
  wid: 'width', hei: 'height', fmt: 'format', qlt: 'quality',
  scl: 'scale', crop: 'crop', fit: 'fit', op_sharpen: 'sharpen', dpr: 'dpr'
};

function translateModifiers(modifierStr) {
  if (!modifierStr) return '';
  const out = new URLSearchParams();
  modifierStr.split('&').filter(seg => seg.includes('=')).forEach(seg => {
    const eqIdx = seg.indexOf('=');
    const k = seg.slice(0, eqIdx).trim();
    let v   = seg.slice(eqIdx + 1).trim();
    if (!k) return;
    const mappedKey = S7_PARAM_MAP[k] || k;
    if (mappedKey === 'dpr' && v.toLowerCase() === 'off') v = '1';
    out.set(mappedKey, v);
  });
  return out.toString();
}

// ── Scene7 recovery: derive name from filename, then confirm against Scene7 ────
// When dam:scene7* metadata is missing on the source (e.g. wiped on Dev), the
// classic Scene7 name can usually be derived from the filename and then CONFIRMED
// with a live existence check against the Scene7 image server. Only a confirmed
// hit is written to the CSV, so we never store a guessed/incorrect S7 reference.
const S7_VERIFY_HOST        = 'abbvie.scene7.com';
const S7_VERIFY_ROOT        = 'abbviecorp';
const S7_VERIFY_CONCURRENCY = 20;

// Candidate Scene7 names for a filename, in preference order (deduped).
function scene7NameCandidates(filename) {
  const base = filename.replace(/\.[^.]+$/, '');   // strip extension
  return [...new Set([
    base,
    base.replace(/\s+/g, ''),
    base.replace(/\s+/g, '-'),
    base.replace(/[^A-Za-z0-9._-]/g, ''),
  ].filter(Boolean))];
}

// Ask Scene7 whether a name exists: GET …/is/image/<root>/<name>?req=exists and
// require HTTP 200 + catalogRecord.exists=1. Resolves false on any error/timeout.
function scene7Exists(host, root, name) {
  return new Promise(resolve => {
    const url = `https://${host}/is/image/${root}/${encodeURIComponent(name)}?req=exists`;
    const req = https.get(url, { agent: httpsAgent }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve(res.statusCode === 200 && /catalogRecord\.exists\s*=\s*1/.test(raw)));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(10000, () => { req.destroy(); resolve(false); });
  });
}

// Fill scene7Name/scene7File for image rows still missing them, by deriving a name
// from the filename and confirming it live. Mutates rows in place; logs progress.
async function verifyScene7ForRows(rows, log, opts = {}) {
  const host = opts.host || S7_VERIFY_HOST;
  const root = opts.root || S7_VERIFY_ROOT;

  const targets = rows.filter(r => {
    if (r.scene7File) return false;                          // already has S7 (crawl or backfill)
    const ext = (r.path.split('.').pop() || '').toLowerCase();
    return DM_IMAGE_EXT.has(ext);                            // only image assets use /is/image/
  });

  if (targets.length === 0) {
    log('Scene7 recovery: no image assets missing scene7File — nothing to verify.');
    return;
  }
  log(`Scene7 recovery: probing ${targets.length} image asset(s) against https://${host}/is/image/${root}/ …`);

  let done = 0, confirmed = 0;
  for (let i = 0; i < targets.length; i += S7_VERIFY_CONCURRENCY) {
    const batch = targets.slice(i, i + S7_VERIFY_CONCURRENCY);
    await Promise.all(batch.map(async row => {
      const filename = path.posix.basename(row.path);
      for (const name of scene7NameCandidates(filename)) {
        if (await scene7Exists(host, root, name)) {
          row.scene7Name = name;
          row.scene7File = `${root}/${name}`;
          confirmed++;
          break;
        }
      }
    }));
    done += batch.length;
    log(`Scene7 recovery: ${done} / ${targets.length} probed, ${confirmed} confirmed`);
  }
  log(`Scene7 recovery complete — ${confirmed} of ${targets.length} image asset(s) recovered and confirmed.`);
}

// ── Scene7 recovery from a legacy source AEM that still has the metadata ───────
// The pre-migration source (config.json → source, e.g. https://34.225.5.238) keeps
// dam:scene7File/dam:scene7Name. Its DAM paths omit the /corporate segment, so we
// strip it, GET <path>/jcr:content/metadata.infinity.json, and (on HTTP 200) read
// the two Scene7 fields straight off the metadata node. Authoritative — preferred
// over filename-derivation. Fill-only-when-empty.
const S7_SOURCE_CONCURRENCY = 15;
const S7_MEDIA_EXT = new Set([...DM_IMAGE_EXT, 'mp4', 'mov', 'm4v', 'webm', 'avi', 'wmv', 'f4v']);

// /content/dam/corporate/abbvie-com2/… → /content/dam/abbvie-com2/…
function stripCorporate(damPath) {
  return String(damPath).replace('/content/dam/corporate/', '/content/dam/');
}

function fetchSourceScene7(host, user, pass, damPath) {
  return new Promise(resolve => {
    const url  = `${host.replace(/\/$/, '')}${stripCorporate(damPath)}/jcr:content/metadata.infinity.json`;
    const auth = Buffer.from(`${user}:${pass}`).toString('base64');
    const lib  = url.startsWith('https') ? https : http;
    const opts = {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      ...(url.startsWith('https') ? { agent: httpsAgent } : {}),
    };
    const req = lib.get(url, opts, res => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          const scene7File = j['dam:scene7File'] || '';
          const scene7Name = j['dam:scene7Name'] || '';
          resolve((scene7File || scene7Name) ? { scene7File, scene7Name } : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

// Fill scene7Name/scene7File for still-missing media rows from the source AEM.
async function recoverScene7FromSource(rows, log, src) {
  if (!src || !src.host || !src.username) {
    log('Scene7 source recovery: no source AEM configured (config.json → source) — skipped.');
    return;
  }
  const targets = rows.filter(r => {
    if (r.scene7File) return false;
    const ext = (r.path.split('.').pop() || '').toLowerCase();
    return S7_MEDIA_EXT.has(ext);
  });
  if (targets.length === 0) {
    log('Scene7 source recovery: no media assets missing scene7File — nothing to pull.');
    return;
  }
  log(`Scene7 source recovery: pulling metadata for ${targets.length} media asset(s) from ${src.host} (/corporate stripped) …`);

  let done = 0, filled = 0;
  for (let i = 0; i < targets.length; i += S7_SOURCE_CONCURRENCY) {
    const batch = targets.slice(i, i + S7_SOURCE_CONCURRENCY);
    await Promise.all(batch.map(async row => {
      const found = await fetchSourceScene7(src.host, src.username, src.password, row.path);
      if (!found) return;
      if (!row.scene7Name && found.scene7Name) row.scene7Name = found.scene7Name;
      if (!row.scene7File && found.scene7File) row.scene7File = found.scene7File;
      filled++;
    }));
    done += batch.length;
    log(`Scene7 source recovery: ${done} / ${targets.length} checked, ${filled} filled`);
  }
  log(`Scene7 source recovery complete — ${filled} of ${targets.length} media asset(s) recovered from source.`);
}

// ── Live DM Open API URL recovery from the current AEM author ──────────────────
// Used by the Link Checker's Fix flow when the asset-map CSV has no usable DM URL
// for a referenced DAM path (missing row, or row crawled before the asset was
// approved). Queries the environment's AEM author directly for that one asset —
// unlike the legacy source above, its DAM paths already carry /corporate/, so no
// path stripping is needed. Two lightweight GETs (mirrors the Page Metadata tool's
// `${path}/jcr:content.1.json` convention): the node itself for jcr:uuid, and its
// jcr:content at depth 1 for the contentFragment flag + dam:status/scene7 metadata.
function fetchAssetFromAuthor(aemUrl, username, password, damPath) {
  const base = aemUrl.replace(/\/$/, '');
  const get  = (url) => new Promise((resolve, reject) => {
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    const lib  = url.startsWith('https') ? https : http;
    const opts = {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      ...(url.startsWith('https') ? { agent: httpsAgent } : {}),
    };
    const req = lib.get(url, opts, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });

  return Promise.all([
    get(`${base}${damPath}.json`),
    get(`${base}${damPath}/jcr:content.1.json`).catch(() => ({})),
  ]).then(([node, content]) => {
    const uuid = (node['jcr:uuid'] || '').trim();
    if (!uuid) return null;
    const cfFlag = content?.contentFragment;
    return {
      uuid,
      isCF:       cfFlag === true || cfFlag === 'true',
      damStatus:  (content?.metadata?.['dam:status'] || '').trim().toLowerCase(),
      scene7Name: content?.metadata?.['dam:scene7Name'] || '',
      scene7File: content?.metadata?.['dam:scene7File'] || '',
    };
  }).catch(() => null);   // asset not found / auth error / network error — treat as "not found"
}

const DM_AUTHOR_RECOVERY_CONCURRENCY = 10;

// Live-check each candidate DAM path against AEM author; on a confirmed approved
// asset, compute its DM Open API URL (same predicate build-csv uses) and write the
// row directly into `pathMap` (by reference) so the caller's current Fix pass picks
// it up immediately. Returns the newly-recovered rows for CSV persistence/reporting.
async function recoverDmUrlsFromAuthor(paths, pathMap, opts, log) {
  const { aemUrl, dmHost, username, password } = opts || {};
  const recovered = [];
  if (!aemUrl || !dmHost || !username) {
    log?.('DM author recovery: no AEM author URL/DM host/credentials available for this environment — skipped.');
    return recovered;
  }
  const cleanHost = dmHost.replace(/^https?:\/\//, '').replace(/\/$/, '');
  log?.(`DM author recovery: checking ${paths.length} unresolved asset(s) against ${aemUrl} …`);

  let checked = 0;
  for (let i = 0; i < paths.length; i += DM_AUTHOR_RECOVERY_CONCURRENCY) {
    const batch = paths.slice(i, i + DM_AUTHOR_RECOVERY_CONCURRENCY);
    await Promise.all(batch.map(async (damPath) => {
      const found = await fetchAssetFromAuthor(aemUrl, username, password, damPath);
      if (found) {
        const filename   = path.posix.basename(damPath);
        const openApiUrl = (!found.isCF && found.uuid && found.damStatus === 'approved')
          ? buildDmOpenApiUrl(cleanHost, found.uuid, filename)
          : damPath;
        if (/^https?:\/\//i.test(openApiUrl)) {
          const row = {
            path: damPath, uuid: found.uuid, scene7Name: found.scene7Name, scene7File: found.scene7File,
            damStatus: found.damStatus, openApiUrl, isCF: found.isCF ? 'true' : 'false',
          };
          pathMap.set(damPath, row);
          recovered.push(row);
        }
      }
    }));
    checked += batch.length;
  }
  log?.(`DM author recovery complete — ${recovered.length} of ${paths.length} asset(s) recovered and confirmed on DM.`);
  return recovered;
}

// Persist newly-recovered rows into data/asset-map-<env>.csv (update by path, or
// append if the row didn't exist before) so future Fix runs never need to re-check
// AEM author for the same asset. Same 7-column schema build-csv writes.
function persistRecoveredRows(env, recoveredRows) {
  if (!recoveredRows || !recoveredRows.length) return;
  const file = csvPath(env);
  const existingRows = fs.existsSync(file)
    ? parse(fs.readFileSync(file, 'utf8'), { columns: true, skip_empty_lines: true })
    : [];
  const byPath = new Map(existingRows.map(r => [r.path, r]));
  for (const r of recoveredRows) byPath.set(r.path, r);
  const csv = stringify([...byPath.values()], {
    header: true,
    columns: [
      { key: 'path',        header: 'path'        },
      { key: 'uuid',        header: 'uuid'        },
      { key: 'scene7Name',  header: 'scene7Name'  },
      { key: 'scene7File',  header: 'scene7File'  },
      { key: 'damStatus',   header: 'damStatus'   },
      { key: 'openApiUrl',  header: 'openApiUrl'  },
      { key: 'isCF',        header: 'isCF'        },
    ],
  });
  fs.writeFileSync(file, csv, 'utf8');
}

// ── Update ZIP ────────────────────────────────────────────────────────────────
app.post('/api/image/update-zip', (req, res, next) => {
  upload.single('zip')(req, res, err => {
    if (err) return res.json({ success: false, error: `Upload error: ${err.message}`, logs: [] });
    next();
  });
}, async (req, res) => {
  const logs = [];
  const log  = msg => { logs.push(msg); console.log('[update-zip]', msg); };

  if (!req.file) return res.json({ success: false, error: 'No ZIP file uploaded.', logs });

  const processingMode = req.body.processingMode || 'shared';
  const targetEnv      = req.body.targetEnv || '';

  let TARGET_CSV, targetDmHost;

  if (processingMode === 'per-env') {
    if (!targetEnv) return res.json({ success: false, error: 'Select a target environment.', logs });
    TARGET_CSV = csvPath(targetEnv);
    if (!fs.existsSync(TARGET_CSV)) {
      return res.json({ success: false, error: `No CSV found for environment "${targetEnv}". Build it first.`, logs });
    }
    targetDmHost = null;
  } else {
    const allCsvs = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('asset-map-') && f.endsWith('.csv'));
    TARGET_CSV = allCsvs.length
      ? path.join(DATA_DIR, allCsvs.sort((a, b) =>
          fs.statSync(path.join(DATA_DIR, b)).mtimeMs - fs.statSync(path.join(DATA_DIR, a)).mtimeMs
        )[0])
      : null;
    if (!TARGET_CSV || !fs.existsSync(TARGET_CSV)) {
      return res.json({ success: false, error: 'No CSV found. Build one first.', logs });
    }
    const siteEnv = loadSiteConfig().environments.find(e => e.name === targetEnv);
    targetDmHost = siteEnv
      ? siteEnv.dmHost.replace(/^https?:\/\//, '').replace(/\/$/, '')
      : null;
    if (targetEnv && !targetDmHost) {
      return res.json({ success: false, error: `Environment "${targetEnv}" not found in site.config.json.`, logs });
    }
  }

  try {
    log(`File received: ${req.file.originalname} (${(req.file.size / 1024).toFixed(1)} KB)`);
    log(`Mode: ${processingMode === 'per-env' ? 'Per-environment CSV' : 'Shared CSV'} | Target: ${targetEnv || '(default)'}`);

    const buildDmUrl = (row) => {
      if (processingMode === 'per-env' || !targetDmHost) return row.openApiUrl;
      if (!row.uuid || row.damStatus !== 'approved') return row.openApiUrl;
      const filename = path.posix.basename(row.path);
      return buildDmOpenApiUrl(targetDmHost, row.uuid, filename);
    };

    const swapDomain = url => url;

    let rootMappings = [];
    try {
      rootMappings = JSON.parse(req.body.rootMappings || '[]').filter(m => m.oldRoot && m.newRoot);
      if (rootMappings.length > 0) log(`Root remappings loaded: ${rootMappings.length}`);
    } catch { log('Warning: could not parse rootMappings, ignoring.'); }

    let customMap = new Map();
    try {
      const customMappings = JSON.parse(req.body.customMappings || '[]');
      customMap = new Map(customMappings.filter(m => m.path && m.url).map(m => [m.path, m.url]));
      if (customMap.size > 0) log(`Exact mappings loaded: ${customMap.size}`);
    } catch { log('Warning: could not parse customMappings, ignoring.'); }

    log('Loading asset CSV...');
    const rows     = parse(fs.readFileSync(TARGET_CSV, 'utf8'), { columns: true, skip_empty_lines: true });
    const pathMap  = new Map(rows.filter(r => r.path && r.openApiUrl).map(r => [r.path, r]));
    const scene7Map = new Map(rows.filter(r => r.scene7File && r.openApiUrl).map(r => [r.scene7File, r]));
    log(`Maps ready — pathMap: ${pathMap.size} | scene7Map: ${scene7Map.size}`);

    log('Opening ZIP...');
    const outerZip      = new AdmZip(req.file.buffer);
    const innerZipEntry = outerZip.getEntries().find(e => !e.isDirectory && e.entryName.endsWith('.zip'));

    let workingZip, isNested;
    if (innerZipEntry) {
      log(`Nested package detected — inner ZIP: ${innerZipEntry.entryName}`);
      workingZip = new AdmZip(innerZipEntry.getData());
      isNested   = true;
    } else {
      log('Flat ZIP detected — processing XML files directly');
      workingZip = outerZip;
      isNested   = false;
    }
    log(`ZIP has ${workingZip.getEntries().length} entries`);

    let filesProcessed = 0, totalRefs = 0, replaced = 0;
    const unmatchedPaths = new Set();
    const reportRows     = [];

    let xmlFilesFound = 0;
    for (const entry of workingZip.getEntries()) {
      if (entry.isDirectory || !entry.entryName.endsWith('.xml')) continue;
      xmlFilesFound++;

      let content;
      try {
        content = entry.getData().toString('utf8');
      } catch (e) {
        log(`Skipping ${entry.entryName} (read error: ${e.message})`);
        continue;
      }
      const original = content;

      content = content.replace(/(['"])(\/content\/dam\/[^'"]+)\1/g, (match, quote, rawPath) => {
        totalRefs++;

        const qIdx        = rawPath.indexOf('?');
        const queryString = (qIdx !== -1 ? rawPath.slice(qIdx + 1) : '').replace(/&amp;/g, '&');
        const presetMatch = queryString.match(/\$([^$]+)\$/);
        const presetName  = presetMatch ? presetMatch[1] : '';
        const modifierStr = queryString.replace(/\$[^$]+\$/g, '').replace(/^&+|&+$/g, '').replace(/&&+/g, '&');
        const translatedParams = translateModifiers(modifierStr);

        const cleanPath = rawPath.split('?')[0].split('#')[0]
          .replace(/\/_jcr_content\/renditions\/.*$/, '')
          .replace(/\.coreimg.*$/, '');

        const applyParams = (baseUrl) => {
          const domainSwapped = swapDomain(baseUrl);
          const out  = new URLSearchParams(translatedParams || '');
          if (presetName) out.set('preset', presetName);
          const qs   = out.toString().replace(/&/g, '&amp;');
          return qs ? `${domainSwapped}?${qs}` : domainSwapped;
        };

        const directRow = pathMap.get(cleanPath);
        if (directRow) {
          if (directRow.isCF === 'true') return match;   // content fragment — leave path unchanged
          replaced++;
          const finalUrl = applyParams(buildDmUrl(directRow));
          reportRows.push({ xmlFile: entry.entryName, oldUrl: rawPath, newUrl: finalUrl, matchType: 'direct', preset: presetName, modifiers: modifierStr });
          return `${quote}${finalUrl}${quote}`;
        }

        const s7match = cleanPath.match(/\/is\/(?:image|content)\/(.+)$/);
        if (s7match) {
          const scene7Row = scene7Map.get(s7match[1]);
          if (scene7Row) {
            replaced++;
            const finalUrl = applyParams(buildDmUrl(scene7Row));
            reportRows.push({ xmlFile: entry.entryName, oldUrl: rawPath, newUrl: finalUrl, matchType: 'scene7', preset: presetName, modifiers: modifierStr });
            return `${quote}${finalUrl}${quote}`;
          }
        }

        for (const { oldRoot, newRoot } of rootMappings) {
          if (cleanPath.startsWith(oldRoot)) {
            const remappedPath = newRoot + cleanPath.slice(oldRoot.length);
            const remappedRow  = pathMap.get(remappedPath);
            if (remappedRow) {
              replaced++;
              const finalUrl = applyParams(buildDmUrl(remappedRow));
              reportRows.push({ xmlFile: entry.entryName, oldUrl: rawPath, newUrl: finalUrl, matchType: 'root-remap', preset: presetName, modifiers: modifierStr });
              return `${quote}${finalUrl}${quote}`;
            }
          }
        }

        const customUrl = customMap.get(cleanPath);
        if (customUrl) {
          replaced++;
          const finalUrl = applyParams(customUrl);
          reportRows.push({ xmlFile: entry.entryName, oldUrl: rawPath, newUrl: finalUrl, matchType: 'custom', preset: presetName, modifiers: modifierStr });
          return `${quote}${finalUrl}${quote}`;
        }

        unmatchedPaths.add(cleanPath);
        reportRows.push({ xmlFile: entry.entryName, oldUrl: rawPath, newUrl: '', matchType: 'unmatched', preset: presetName, modifiers: modifierStr });
        return match;
      });

      content = content.replace(/(['"])(https?:\/\/[^'"]*\.scene7\.com\/is\/(?:image|content)\/([^?'"]+)([^'"]*)?)\1/g, (match, quote, fullUrl, s7Key, qs) => {
        totalRefs++;

        const queryString = (qs ? qs.replace(/^\?/, '') : '').replace(/&amp;/g, '&');
        const presetMatch = queryString.match(/\$([^$]+)\$/);
        const presetName  = presetMatch ? presetMatch[1] : '';
        const modifierStr = queryString
          .replace(/\$[^$]+\$/g, '')
          .replace(/(?:^|&)ts=[^&]*/g, '')
          .replace(/^&+|&+$/g, '')
          .replace(/&&+/g, '&');
        const translatedParams = translateModifiers(modifierStr);

        const applyParams = (baseUrl) => {
          const domainSwapped = swapDomain(baseUrl);
          const out  = new URLSearchParams(translatedParams || '');
          if (presetName) out.set('preset', presetName);
          const qstr = out.toString().replace(/&/g, '&amp;');
          return qstr ? `${domainSwapped}?${qstr}` : domainSwapped;
        };

        const scene7Row = scene7Map.get(s7Key.trim());
        if (scene7Row) {
          replaced++;
          const finalUrl = applyParams(buildDmUrl(scene7Row));
          reportRows.push({ xmlFile: entry.entryName, oldUrl: fullUrl, newUrl: finalUrl, matchType: 'scene7-cdn', preset: presetName, modifiers: modifierStr });
          return `${quote}${finalUrl}${quote}`;
        }

        unmatchedPaths.add(s7Key.trim());
        reportRows.push({ xmlFile: entry.entryName, oldUrl: fullUrl, newUrl: '', matchType: 'unmatched', preset: presetName, modifiers: modifierStr });
        return match;
      });

      if (content !== original) {
        workingZip.updateFile(entry.entryName, Buffer.from(content, 'utf8'));
        filesProcessed++;
        log(`Updated: ${entry.entryName}`);
      }
    }

    log(`XML files scanned: ${xmlFilesFound} | References found: ${totalRefs} | Replaced: ${replaced} | Unmatched: ${unmatchedPaths.size}`);
    log(`Report rows: ${reportRows.length}`);

    log('Rebuilding ZIP...');
    const timestamp      = Date.now();
    const envSuffix      = targetEnv ? `_${envSlug(targetEnv)}` : '';
    const outputFilename = `updated${envSuffix}_${timestamp}.zip`;
    const outputPath     = path.join(OUTPUT_DIR, outputFilename);

    const admToJszip = async (admZip) => {
      const jz = new JSZip();
      for (const entry of admZip.getEntries()) {
        if (entry.isDirectory) continue;
        let data;
        try { data = entry.getData(); } catch (e) { continue; }
        jz.file(entry.entryName, data);
      }
      return jz;
    };

    if (isNested) {
      const innerJszip = await admToJszip(workingZip);
      const innerBuf   = await innerJszip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      const outerJszip = await admToJszip(outerZip);
      outerJszip.file(innerZipEntry.entryName, innerBuf);
      const outerBuf = await outerJszip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      fs.writeFileSync(outputPath, outerBuf);
    } else {
      const jz  = await admToJszip(workingZip);
      const buf = await jz.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      fs.writeFileSync(outputPath, buf);
    }
    log(`ZIP saved: ${outputFilename}`);

    const reportFilename = `report${envSuffix}_${timestamp}.csv`;
    fs.writeFileSync(
      path.join(OUTPUT_DIR, reportFilename),
      stringify(reportRows, {
        header: true,
        columns: [
          { key: 'xmlFile',   header: 'xmlFile'   },
          { key: 'oldUrl',    header: 'oldUrl'    },
          { key: 'newUrl',    header: 'newUrl'    },
          { key: 'matchType', header: 'matchType' },
          { key: 'preset',    header: 'preset'    },
          { key: 'modifiers', header: 'modifiers' },
        ],
      }),
      'utf8'
    );
    log(`Report saved: ${reportFilename}`);

    res.json({
      success: true,
      outputFile: outputFilename,
      reportFile: reportFilename,
      logs,
      stats: { total: totalRefs, replaced, unmatched: unmatchedPaths.size, filesProcessed },
      unmatchedPaths: [...unmatchedPaths].slice(0, 100),
    });
  } catch (err) {
    log(`Error: ${err.message}`);
    res.json({ success: false, error: err.message, logs });
  }
});

// ── Domain Swap Only ──────────────────────────────────────────────────────────
app.post('/api/image/swap-domain', upload.single('zip'), async (req, res) => {
  const logs = [];
  const log  = msg => { logs.push(msg); console.log(msg); };

  const targetEnv = (req.body.targetEnv || '').trim();
  if (!targetEnv) return res.json({ success: false, error: 'Select a target environment.', logs });
  if (!req.file)  return res.json({ success: false, error: 'No ZIP uploaded.', logs });

  const siteEnv = loadSiteConfig().environments.find(e => e.name === targetEnv);
  if (!siteEnv) return res.json({ success: false, error: `Environment "${targetEnv}" not found in site.config.json.`, logs });

  const newDmHost = siteEnv.dmHost.replace(/^https?:\/\//, '').replace(/\/$/, '');
  log(`Target environment: ${targetEnv}`);
  log(`New delivery host:  ${newDmHost}`);

  try {
    log(`File received: ${req.file.originalname} (${(req.file.size / 1024).toFixed(1)} KB)`);

    const outerJszip = await JSZip.loadAsync(req.file.buffer);

    let workingJszip, isNested, innerZipName;
    const innerZipFile = Object.entries(outerJszip.files)
      .find(([name, f]) => !f.dir && name.endsWith('.zip'));

    if (innerZipFile) {
      innerZipName = innerZipFile[0];
      log(`Nested package detected — inner ZIP: ${innerZipName}`);
      const innerBuf = await innerZipFile[1].async('nodebuffer');
      workingJszip = await JSZip.loadAsync(innerBuf);
      isNested     = true;
    } else {
      log('Flat ZIP detected — processing XML files directly');
      workingJszip = outerJszip;
      isNested     = false;
    }

    const allEntries = Object.keys(workingJszip.files);
    log(`ZIP has ${allEntries.length} entries`);

    // Capture the full DM URL (host + asset path) so the report shows the complete old/new URL.
    // Stops at a quote, whitespace, angle bracket, or entity boundary (&) for entity-encoded XML.
    const domainRe = /(https?:\/\/)([^/'"]+)(\/adobe\/assets\/[^'"<>\s&\\]*)/g;
    let xmlFilesFound = 0, totalRefs = 0, replaced = 0, skipped = 0, filesProcessed = 0;
    const reportRows = [];

    for (const [filename, file] of Object.entries(workingJszip.files)) {
      if (file.dir || !filename.endsWith('.xml')) continue;
      xmlFilesFound++;

      const original = await file.async('string');
      let fileChanged = false;

      const content = original.replace(domainRe, (match, proto, oldHost, rest) => {
        totalRefs++;
        const oldUrl = `${proto}${oldHost}${rest}`;
        if (oldHost === newDmHost) {
          // Already pointing at the target environment — left unchanged, but still reported.
          skipped++;
          reportRows.push({ xmlFile: filename, oldUrl, newUrl: oldUrl, status: 'skipped (already on target host)' });
          return match;
        }
        replaced++;
        const newUrl = `${proto}${newDmHost}${rest}`;
        reportRows.push({ xmlFile: filename, oldUrl, newUrl, status: 'replaced' });
        fileChanged = true;
        return newUrl;
      });

      if (fileChanged) {
        workingJszip.file(filename, content);
        filesProcessed++;
        log(`Updated: ${filename}`);
      }
    }

    log(`XML files scanned: ${xmlFilesFound} | DM URL references found: ${totalRefs} | Replaced: ${replaced} | Skipped (already on target): ${skipped}`);
    log(`Report rows: ${reportRows.length}`);

    log('Rebuilding ZIP...');
    const timestamp      = Date.now();
    const envSuffixSwap  = `_${envSlug(targetEnv)}`;
    const outputFilename = `swapped${envSuffixSwap}_${timestamp}.zip`;
    const outputPath     = path.join(OUTPUT_DIR, outputFilename);

    if (isNested) {
      const innerBuf = await workingJszip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      outerJszip.file(innerZipName, innerBuf);
      const outerBuf = await outerJszip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      fs.writeFileSync(outputPath, outerBuf);
    } else {
      const buf = await workingJszip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      fs.writeFileSync(outputPath, buf);
    }
    log(`ZIP saved: ${outputFilename}`);

    const reportFilename = `swap-report${envSuffixSwap}_${timestamp}.csv`;
    fs.writeFileSync(
      path.join(OUTPUT_DIR, reportFilename),
      stringify(reportRows, {
        header: true,
        columns: [
          { key: 'xmlFile', header: 'xmlFile' },
          { key: 'oldUrl',  header: 'oldUrl'  },
          { key: 'newUrl',  header: 'newUrl'  },
          { key: 'status',  header: 'status'  },
        ],
      }),
      'utf8'
    );
    log(`Report saved: ${reportFilename}`);

    res.json({
      success: true,
      outputFile: outputFilename,
      reportFile: reportFilename,
      logs,
      stats: { total: totalRefs, replaced, skipped, filesProcessed },
    });
  } catch (err) {
    log(`Error: ${err.message}`);
    res.json({ success: false, error: err.message, logs });
  }
});

// ── Download ──────────────────────────────────────────────────────────────────
app.get('/api/image/download/:filename', (req, res) => {
  const filePath = path.join(OUTPUT_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found.');
  res.download(filePath);
});

// ── QueryBuilder pagination ───────────────────────────────────────────────────
async function queryAllAssets(aemUrl, username, password, damRoot, log) {
  const assets = [];
  let offset = 0;
  const limit = 1000;
  let more = true;
  let guessedTotal = null;

  while (more) {
    const params = new URLSearchParams({
      'p.hits':        'selective',
      'p.properties':  'jcr:uuid jcr:content/contentFragment jcr:content/metadata/dam:scene7Name jcr:content/metadata/dam:scene7File jcr:content/metadata/dam:status jcr:path',
      'p.guessTotal':  'true',
      path:            damRoot,
      type:            'dam:Asset',
      'p.limit':       String(limit),
      'p.offset':      String(offset),
    });

    const url  = `${aemUrl}/bin/querybuilder.json?${params.toString()}`;
    const data = await fetchJson(url, username, password);

    if (!Array.isArray(data.hits)) {
      throw new Error(`Unexpected QueryBuilder response: ${JSON.stringify(data).substring(0, 300)}`);
    }

    if (guessedTotal === null) guessedTotal = data.total || 0;
    assets.push(...data.hits);
    more    = data.more === true;
    offset += limit;

    const pct = guessedTotal > 0 ? Math.min(100, Math.round((assets.length / guessedTotal) * 100)) : '?';
    log(`Page ${Math.ceil(offset / limit)} — ${assets.length.toLocaleString()} / ~${Number(guessedTotal).toLocaleString()} assets (${pct}%)`);
  }

  return assets;
}

function fetchJson(url, username, password) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    const lib  = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } }, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('Unauthorized — check credentials.'));
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${raw.substring(0, 200)}`));
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error(`Invalid JSON from AEM: ${raw.substring(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// LINK CHECKER TOOL  (/api/link-checker/*)
// ══════════════════════════════════════════════════════════════════════════════

// ── Link extraction helpers ───────────────────────────────────────────────────

const NAMESPACE_SKIP = /^https?:\/\/(www\.(jcp|day|adobe)\.org|www\.day\.com|sling\.apache\.org|jackrabbit\.apache\.org|www\.w3\.org|ns\.adobe\.com|purl\.org)\//i;

function extractLinks(xmlContent) {
  const decoded = xmlContent
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

  const seen  = new Set();
  const links = [];

  const add = (raw) => {
    const url = raw.replace(/[.,;:!?)>\]]+$/, '').trim();
    if (!url || url.length < 4 || seen.has(url)) return;
    if (NAMESPACE_SKIP.test(url)) return;
    seen.add(url);
    links.push(url);
  };

  // Quoted attribute values that ARE a single /content/... path — capture the WHOLE value,
  // allowing spaces (AEM asset filenames can contain them, e.g. "Woman standing at desk.jpg").
  // Runs first so spaced asset paths are captured in full before the whitespace-terminated passes.
  for (const m of decoded.matchAll(/=(["'])(\/content\/[^"'<>]+)\1/g)) add(m[2]);

  for (const m of decoded.matchAll(/["'\s=>(](\/(content)\/[^"'\s<>&\]{}|\\]+)/g)) add(m[1]);
  for (const m of decoded.matchAll(/["'\s=>(](https?:\/\/[^"'\s<>&\]{}|\\]+)/g)) add(m[1]);
  for (const m of decoded.matchAll(/["'\s=>(](\/[a-zA-Z][a-zA-Z0-9-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)+)/g)) {
    const p = m[1];
    if (/^\/(content|etc|apps|libs|bin|var|conf|home|crx|jcr|oak|system|mnt|tmp|is)\//i.test(p)) continue;
    add(p);
  }

  return links;
}

function classifyLink(url) {
  if (/delivery-p\d+-e\d+/i.test(url) || /\/adobe\/assets\//i.test(url)) return 'dm-openapi';
  if (/\.scene7\.com|\/is\/(?:image|content)\//i.test(url)) return 'scene7';
  if (/adobeaemcloud\.com|adobe\.com/i.test(url)) return 'aem-cloud';
  if (/^https?:\/\/(www\.)?abbvie\.com(\/|$)/i.test(url)) return 'abbvie-abs';
  if (url.startsWith('/content/dam/')) return 'dam';
  if (url.startsWith('/content/'))    return 'internal';
  if (/^https?:\/\//i.test(url))      return 'external';
  if (/^\/[a-zA-Z]/.test(url))        return 'short-path';
  return 'other';
}

// ── In-memory ZIP session store ───────────────────────────────────────────────
const lcSessions = new Map();
// Change reports from the last fix, keyed by reportId. Auto-expire after 15 min.
const lcReports  = new Map();

// ── Fix helpers ───────────────────────────────────────────────────────────────

// Longest k where the last k segments of `pre` equal the first k segments of `sp`.
function segOverlap(pre, sp) {
  for (let k = Math.min(pre.length, sp.length); k >= 1; k--) {
    let ok = true;
    for (let i = 0; i < k; i++) {
      if (pre[pre.length - k + i] !== sp[i]) { ok = false; break; }
    }
    if (ok) return k;
  }
  return 0;
}

// Join a prefix to a short path, collapsing any overlapping segments so a
// partial-absolute path that already contains the prefix tail isn't duplicated.
function joinWithPrefix(prefix, p) {
  const pre = prefix.split('/').filter(Boolean);
  const sp  = p.split('/').filter(Boolean);
  return '/' + [...pre, ...sp.slice(segOverlap(pre, sp))].join('/');
}

// localeRoot = the file's own locale root (e.g. .../abbvie-com/us/en)
// siteRoot   = the shared site root  (e.g. .../abbvie-com)
function fixShortPaths(xmlContent, localeRoot, siteRoot) {
  const SYSTEM_SKIP = /^\/(content|etc|apps|libs|bin|var|conf|home|crx|jcr|oak|system|mnt|tmp|is)\//i;
  const PATH_RE = /([="']|&quot;)(\/[a-zA-Z][a-zA-Z0-9-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)+)/g;
  const siteSegs = (siteRoot || '').split('/').filter(Boolean);
  const changes = [];
  const result = xmlContent.replace(PATH_RE, (match, delim, p) => {
    if (SYSTEM_SKIP.test(p) || p.startsWith(localeRoot)) return match;
    const cleaned = p.replace(/\.html?$/i, '');   // AEM content paths are extensionless
    const cleanedSegs = cleaned.split('/').filter(Boolean);
    // If the path begins with a tail of the SITE ROOT (e.g. /corporate/abbvie-com/...),
    // it is site-root-relative and already carries its own locale → complete it against
    // the site root. Otherwise it is relative to THIS file's locale.
    const np = (siteRoot && segOverlap(siteSegs, cleanedSegs) > 0)
      ? joinWithPrefix(siteRoot, cleaned)
      : joinWithPrefix(localeRoot, cleaned);
    if (np === p) return match;
    changes.push({ oldUrl: p, newUrl: np });
    return delim + np;
  });
  return { result, changes };
}

// Returns the site root (longest common /content/ prefix) and detected locale names
function detectSiteInfo(admZip) {
  let dirs = admZip.getEntries()
    .filter(e => !e.isDirectory && e.entryName.endsWith('.xml'))
    .map(e => e.entryName.replace(/^jcr_root/, '').replace(/\/[^/]+$/, ''))
    .filter(p => p.startsWith('/content/'));
  if (!dirs.length) return { siteRoot: null, locales: [] };

  dirs = [...new Set(dirs)];

  // Drop directories that are strict ancestors of another directory. These are
  // shallow nodes — e.g. the site's own /content/<site>/.content.xml or a stray
  // node directly under /content — that would otherwise collapse the longest
  // common path to far too shallow a root. We detect the site root from the
  // deepest ("leaf") content directories only.
  const basis = dirs.filter(d => !dirs.some(o => o !== d && o.startsWith(d + '/')));
  const leafDirs = basis.length ? basis : dirs;

  const segments = leafDirs[0].split('/').filter(Boolean);
  const common = [];
  for (let i = 0; i < segments.length; i++) {
    if (leafDirs.every(p => p.split('/').filter(Boolean)[i] === segments[i])) common.push(segments[i]);
    else break;
  }
  const siteRoot = '/' + common.join('/');
  const depth    = common.length;

  const localeSet = new Set();
  for (const dir of leafDirs) {
    const parts = dir.split('/').filter(Boolean);
    if (parts.length > depth) localeSet.add(parts[depth]);
  }
  return { siteRoot, locales: [...localeSet].sort() };
}

// Derive the locale root for a specific XML entry from its ZIP path
function getFileLocaleRoot(entryName, siteRoot) {
  const jcrDir = entryName.replace(/^jcr_root/, '').replace(/\/[^/]+$/, '');
  if (!jcrDir.startsWith(siteRoot + '/')) return siteRoot;
  const rel       = jcrDir.slice(siteRoot.length + 1);
  const localeSeg = rel.split('/').slice(0, 2).join('/');
  return siteRoot + '/' + localeSeg;
}

// Look up which domain owns a given localeRoot by matching against the explicit
// liveCopyPath and blueprintPath entries in site.config.json locales.
// Prefix matching handles sub-locales: /gr matches /gr/el, /language-masters/gr, etc.
function getDomainForLocale(localeRoot, locales) {
  if (!localeRoot || !locales?.length) return null;
  for (const entry of locales) {
    for (const root of [entry.liveCopyPath, entry.blueprintPath].filter(Boolean)) {
      if (localeRoot === root || localeRoot.startsWith(root + '/')) return entry.domain;
    }
  }
  return null;
}

// The site-qualifier segments (everything after /content/dam/) across the correct
// root and the old roots — e.g. { corporate, abbvie-com2, abbvie-com }. These are
// the segments that belong in the DAM root, so a stray copy left in the asset path
// (e.g. /content/dam/abbvie-com2/corporate/pdfs/...) should be collapsed.
function damQualifiers(correctRoot, oldRoots) {
  const set = new Set();
  for (const r of [correctRoot, ...oldRoots]) {
    const segs = r.split('/').filter(Boolean);
    let i = 0;
    while (i < segs.length && (segs[i] === 'content' || segs[i] === 'dam')) i++;
    for (; i < segs.length; i++) set.add(segs[i]);
  }
  return set;
}

// Normalize a single DAM path:
//  1. repair a dotted qualifier segment (corporate.abbvie-com2 → corporate/abbvie-com2),
//  2. rewrite a known-incorrect DAM prefix to the correct root,
//  3. drop any stray site-qualifier segments left at the head of the asset path.
// Returns the path unchanged if none of these apply.
//   /content/dam/abbvie-com2/pdfs/x.pdf            → /content/dam/corporate/abbvie-com2/pdfs/x.pdf
//   /content/dam/abbvie-com2/corporate/pdfs/x.pdf  → /content/dam/corporate/abbvie-com2/pdfs/x.pdf   (stray "corporate" collapsed)
//   /content/dam/corporate.abbvie-com2/pdfs/x.pdf  → /content/dam/corporate/abbvie-com2/pdfs/x.pdf   (dotted segment repaired)
function normalizeDamPrefix(p, correctRoot, oldRoots) {
  if (!correctRoot || !oldRoots?.length) return p;
  const quals = damQualifiers(correctRoot, oldRoots);

  // 1. Repair a dotted qualifier segment right after /content/dam/. Only split when
  //    every dot-part is a known qualifier, so real filenames (jameson-tile.webp) are safe.
  const work = p.replace(/^(\/content\/dam\/)([^/]+)/, (m, base, seg) => {
    const parts = seg.split('.');
    return (parts.length >= 2 && parts.every(s => quals.has(s))) ? base + parts.join('/') : m;
  });

  // 2. Match against an old root (or the correct root itself, for repaired/stray cases).
  //    Longest root first so the most specific prefix wins.
  const roots = [...oldRoots, correctRoot].sort((a, b) => b.length - a.length);
  for (const root of roots) {
    if (root !== correctRoot && correctRoot.startsWith(root + '/')) continue;  // would re-match its own output
    if (work === root || work.startsWith(root + '/')) {
      const restSegs = work.slice(root.length).split('/').filter(Boolean);
      while (restSegs.length && quals.has(restSegs[0])) restSegs.shift();       // collapse stray qualifiers
      return restSegs.length ? `${correctRoot}/${restSegs.join('/')}` : correctRoot;
    }
  }
  return work;   // dot-repair may have changed it even if no root matched
}

// Strip absolute base-site URL, strip .html, prepend file's locale root.
// Matches the bare domain and its www. form (e.g. abbvie.com / www.abbvie.com)
// but NOT other subdomains (e.g. careers.abbvie.com), which are left unchanged.
// When the embedded path is an absolute /content/dam/... ref, its DAM prefix is
// normalized here too (using damCfg) so the result is correct in a single step.
function fixAbsBaseUrl(xmlContent, baseDomain, localeRoot, damCfg) {
  const root    = localeRoot.replace(/\/$/, '');
  const bare    = baseDomain.replace(/^www\./i, '');
  const escaped = bare.replace(/\./g, '\\.');
  // Exclude '&' so an entity-encoded boundary (&quot;) terminates the path (and so a trailing
  // .html before &quot; is still stripped) instead of leaking into the captured path.
  const RE = new RegExp(`([="']|&quot;)https?://(?:www\\.)?${escaped}(/[^"'<>\\s&]*)`, 'gi');
  const changes = [];
  const result = xmlContent.replace(RE, (match, delim, urlPath) => {
    const cleanPath = urlPath.replace(/\.html?$/, '');
    // Paths already pointing into the repository (e.g. absolute DAM/page refs):
    // strip the domain and normalize a DAM prefix in place. Other paths get the
    // file's locale root prepended.
    const np = cleanPath.startsWith('/content/')
      ? (damCfg ? normalizeDamPrefix(cleanPath, damCfg.correctRoot, damCfg.oldRoots) : cleanPath)
      : root + cleanPath;
    changes.push({ oldUrl: match.slice(delim.length), newUrl: np });
    return delim + np;
  });
  return { result, changes };
}

// Build lookup map from the asset-map CSV.
// CSV columns: path, uuid, scene7Name, scene7File, damStatus, openApiUrl
//   scene7File = 'abbviecorp/<name>'  (full Scene7 key, matches the URL path)
//   scene7Name = '<name>'             (bare name, used as a fallback key)
//   openApiUrl = DM delivery URL (or a /content/dam path if not yet published)
function buildScene7LookupMap(csvRows) {
  const map = new Map();
  for (const row of csvRows) {
    if (!row.openApiUrl) continue;
    if (row.scene7File) map.set(row.scene7File.toLowerCase(), row.openApiUrl);
    if (row.scene7Name && !map.has(row.scene7Name.toLowerCase())) {
      map.set(row.scene7Name.toLowerCase(), row.openApiUrl);
    }
  }
  return map;
}

// Replace Scene7 URLs using CSV lookup map
function fixScene7WithCsv(xmlContent, lookupMap) {
  let unmatched = 0;
  const changes       = [];
  const unmatchedList = [];
  // CSV keys are stored decoded (raw spaces) while URLs in XML are percent-encoded
  // (e.g. Cambridge%20Scientists), so we try both the decoded and raw forms.
  // CSV delivery URLs may also contain raw spaces — re-encode them for valid XML.
  const enc = url => url.replace(/ /g, '%20');
  // Exclude '&' so an entity-encoded boundary (&quot;) terminates the URL instead of leaking into the key
  const RE = /([="']|&quot;)(https?:\/\/[^"'<>\s&]*\.scene7\.com\/is\/(?:image|content)\/([^"'<>\s?&]+)(?:\?[^"'<>\s&]*)?)/gi;
  const result = xmlContent.replace(RE, (match, delim, fullUrl, s7Key) => {
    const cleanKey = s7Key.replace(/\?.*$/, '').trim();
    let decodedKey = cleanKey;
    try { decodedKey = decodeURIComponent(cleanKey); } catch { /* malformed % escape — keep raw */ }
    const dmUrl =
         lookupMap.get(decodedKey.toLowerCase())
      || lookupMap.get(cleanKey.toLowerCase())
      || lookupMap.get(decodedKey.split('/').pop().toLowerCase())
      || lookupMap.get(cleanKey.split('/').pop().toLowerCase());
    if (dmUrl) {
      const finalUrl = enc(dmUrl);
      changes.push({ oldUrl: fullUrl, newUrl: finalUrl });
      return delim + finalUrl;
    }
    unmatched++;
    unmatchedList.push(fullUrl);
    return match;
  });
  return { result, unmatched, changes, unmatchedList };
}

// Normalize incorrect DAM path prefixes to the correct one (delegates per-path to
// normalizeDamPrefix so prefix-swap + stray-qualifier collapse stay consistent).
function fixDamPaths(xmlContent, correctDamRoot, oldDamRoots) {
  const changes = [];
  const RE = /(["'=]|&quot;)(\/content\/dam\/[^"'<>\s&]*)/g;
  const result = xmlContent.replace(RE, (m, delim, damPath) => {
    const np = normalizeDamPrefix(damPath, correctDamRoot, oldDamRoots);
    if (np === damPath) return m;
    changes.push({ oldUrl: damPath, newUrl: np });
    return delim + np;
  });
  return { result, changes };
}

// Package-control / config content that must never be rewritten — copy through as-is.
// The entire META-INF tree, a literal redirects.xml / filter.xml file anywhere, a
// `redirects` JCR node, and the site `config` node (universal-editor-config, etc.).
function lcIsSkipped(name) {
  const segs = name.split('/');
  if (segs.includes('META-INF')) return true;
  if (segs[segs.length - 1] === 'redirects.xml' || segs[segs.length - 1] === 'filter.xml') return true;
  if (segs.includes('redirects')) return true;
  if (segs.includes('config')) return true;
  if (segs.includes('drafts') || segs.includes('draft') || segs.includes('preview')) return true;   // test/draft pages — not real content
  return false;
}

// PDF fixes in one pass:
//  Pass 1 (needs pathMap) — convert DAM PDF refs (bare or embedded in an absolute URL)
//          to their DM Open API URL; the DAM prefix is normalized first so un-normalized
//          paths still match, and the result uses /original/as/.
//  Pass 2 (always) — correct EXISTING DM delivery PDF URLs that were written with /as/
//          instead of /original/as/.
// Only actual replacements are recorded in `changes`; unmatched refs are just counted.
function fixPdfDamRefs(xmlContent, pathMap, damNorm) {
  const changes = [];
  let converted = 0, unmatched = 0, originalFixed = 0;
  let result = xmlContent;

  if (pathMap) {
    const RE = /(["'=]|&quot;)(?:https?:\/\/[^"'<>\s&]*?)?(\/content\/dam\/[^"'<>\s&]*?\.pdf)/gi;
    result = result.replace(RE, (m, delim, pdfPath) => {
      const oldFull = m.slice(delim.length);   // full original ref (may include the domain)
      const raw  = pdfPath.split('?')[0].split('#')[0];
      const norm = damNorm ? normalizeDamPrefix(raw, damNorm.correctRoot, damNorm.oldRoots) : raw;
      const dm   = pathMap.get(raw) || pathMap.get(norm);
      if (dm && /^https?:\/\//i.test(dm)) {
        converted++;
        const dmUrl = ensureOriginalDelivery(dm);   // PDFs deliver via /original/as/
        changes.push({ oldUrl: oldFull, newUrl: dmUrl, status: 'converted' });
        return delim + dmUrl;
      }
      unmatched++;
      return m;
    });
  }

  // Pass 2 — existing DM delivery PDF URLs missing /original/as/
  const RE2 = /(["'=]|&quot;)(https?:\/\/[^"'<>\s&]*\/adobe\/assets\/[^"'<>\s&]+?\/as\/[^"'<>\s&]+?\.pdf)/gi;
  result = result.replace(RE2, (m, delim, url) => {
    const fixed = ensureOriginalDelivery(url);
    if (fixed !== url) {
      originalFixed++;
      changes.push({ oldUrl: url, newUrl: fixed, status: 'original-path fixed' });
      return delim + fixed;
    }
    return m;
  });

  return { result, changes, converted, unmatched, originalFixed };
}

// Build a ZIP with all PDF DAM links converted to DM Open API URLs (handles nested ZIPs).
async function convertPdfsInZip(originalBuffer, pathMap, damNorm) {
  const outerAdm   = new AdmZip(originalBuffer);
  const innerEntry = outerAdm.getEntries().find(e => !e.isDirectory && e.entryName.endsWith('.zip'));
  const changes = [];
  let converted = 0, unmatched = 0;

  async function patch(admZip) {
    const jsz = new JSZip();
    for (const e of admZip.getEntries()) {
      if (e.isDirectory) continue;
      if (e.entryName.endsWith('.xml') && !lcIsSkipped(e.entryName)) {
        const before = e.getData().toString('utf8');
        const r = fixPdfDamRefs(before, pathMap, damNorm);
        converted += r.converted; unmatched += r.unmatched;
        for (const c of r.changes) changes.push({ file: e.entryName.replace(/^jcr_root/, ''), ...c });
        jsz.file(e.entryName, r.result);
      } else {
        jsz.file(e.entryName, e.getData());
      }
    }
    return jsz.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  if (innerEntry) {
    const patchedInner = await patch(new AdmZip(innerEntry.getData()));
    const outerJsz = new JSZip();
    for (const e of outerAdm.getEntries()) {
      if (e.isDirectory) continue;
      outerJsz.file(e.entryName, e.entryName === innerEntry.entryName ? patchedInner : e.getData());
    }
    return { buf: await outerJsz.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), changes, converted, unmatched };
  }
  return { buf: await patch(outerAdm), changes, converted, unmatched };
}

// Build a fixed ZIP applying all requested fixes per-file
// fixes = { siteRoot, shortPath?, scene7?: { lookupMap }, absBaseUrl?: { baseDomain }, damPaths?: { correctRoot, oldRoots } }
async function buildFixedZip(originalBuffer, fixes) {
  const outerAdm   = new AdmZip(originalBuffer);
  const innerEntry = outerAdm.getEntries().find(e => !e.isDirectory && e.entryName.endsWith('.zip'));
  let fixedCount    = 0;
  let unmatchedScene7 = 0;
  const changes        = [];   // { file, type, oldUrl, newUrl }
  const unmatchedList  = [];   // { file, oldUrl }  — Scene7 URLs with no CSV match

  // Strip the leading jcr_root/ from a ZIP entry name for cleaner report paths
  const reportPath = name => name.replace(/^jcr_root/, '');

  async function patchEntries(admZip) {
    const jsz = new JSZip();
    for (const e of admZip.getEntries()) {
      if (e.isDirectory) continue;
      if (e.entryName.endsWith('.xml') && !lcIsSkipped(e.entryName)) {
        const before    = e.getData().toString('utf8');
        let after       = before;
        const file       = reportPath(e.entryName);
        const localeRoot = fixes.siteRoot ? getFileLocaleRoot(e.entryName, fixes.siteRoot) : '';

        // DAM config (shared by abbvie-abs in-place normalization and the standalone DAM fix)
        const damCfg = (fixes.damPaths?.correctRoot && fixes.damPaths?.oldRoots?.length)
          ? fixes.damPaths : null;

        // 0. PDF DAM links → DM Open API URLs (first, so the absolute DM URLs are immune
        //    to the later fixers), plus correct existing DM PDF URLs missing /original/as/.
        if (fixes.pdfToDm) {
          const r = fixPdfDamRefs(after, fixes.pdfToDm.pathMap, fixes.pdfToDm.damNorm);
          after = r.result;
          for (const c of r.changes) changes.push({ file, type: 'pdf-dm', ...c });
        }

        // 1. Fix absolute base-site URLs first → output /content/..., immune to short-path fixer.
        //    Embedded /content/dam/... refs get their DAM prefix normalized in the same step.
        //    When a localeMap is configured (from site.config.json locales), only convert links
        //    whose domain matches the domain assigned to this file's locale — links pointing to
        //    another locale's domain (e.g. abbvie.com links on an abbvie.gr page) are left as-is.
        if (fixes.absBaseUrl && localeRoot) {
          const domainForLocale = fixes.absBaseUrl.locales?.length
            ? getDomainForLocale(localeRoot, fixes.absBaseUrl.locales)  // prefix match vs liveCopyPath + blueprintPath
            : fixes.absBaseUrl.baseDomain;                              // legacy fallback: no locales configured
          if (domainForLocale) {
            const r = fixAbsBaseUrl(after, domainForLocale, localeRoot, damCfg);
            after = r.result;
            for (const c of r.changes) changes.push({ file, type: 'abbvie-abs', ...c });
          }
        }
        // 2. Fix Scene7 URLs via CSV lookup
        if (fixes.scene7?.lookupMap) {
          const r = fixScene7WithCsv(after, fixes.scene7.lookupMap);
          after = r.result;
          unmatchedScene7 += r.unmatched;
          for (const c of r.changes)        changes.push({ file, type: 'scene7', ...c });
          for (const u of r.unmatchedList)  unmatchedList.push({ file, oldUrl: u });
        }
        // 3. Normalize DAM path prefixes
        if (fixes.damPaths?.correctRoot && fixes.damPaths?.oldRoots?.length) {
          const r = fixDamPaths(after, fixes.damPaths.correctRoot, fixes.damPaths.oldRoots);
          after = r.result;
          for (const c of r.changes) changes.push({ file, type: 'dam-path', ...c });
        }
        // 4. Fix short paths last — SYSTEM_SKIP prevents re-processing /content/ paths
        if (fixes.shortPath && localeRoot) {
          const r = fixShortPaths(after, localeRoot, fixes.siteRoot);
          after = r.result;
          for (const c of r.changes) changes.push({ file, type: 'short-path', ...c });
        }

        if (before !== after) fixedCount++;
        jsz.file(e.entryName, after);
      } else {
        jsz.file(e.entryName, e.getData());
      }
    }
    return jsz.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  if (innerEntry) {
    const innerAdm     = new AdmZip(innerEntry.getData());
    const patchedInner = await patchEntries(innerAdm);
    const outerJsz     = new JSZip();
    for (const e of outerAdm.getEntries()) {
      if (e.isDirectory) continue;
      outerJsz.file(e.entryName, e.entryName === innerEntry.entryName ? patchedInner : e.getData());
    }
    const buf = await outerJsz.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return { buf, fixedCount, unmatchedScene7, changes, unmatchedList };
  }

  const buf = await patchEntries(outerAdm);
  return { buf, fixedCount, unmatchedScene7, changes, unmatchedList };
}

// ══════════════════════════════════════════════════════════════════════════════
// MIGRATION QA (Franklin-page link checker) — detection + fix
// Only real EDS/Franklin pages are inspected: an XML is scanned/fixed only when it
// carries cq:template="/libs/core/franklin/templates/page".
// ══════════════════════════════════════════════════════════════════════════════
const FRANKLIN_PAGE_RE = /cq:template\s*=\s*"\/libs\/core\/franklin\/templates\/page"/;
const isFranklinPage = xml => FRANKLIN_PAGE_RE.test(xml);

// Host of an absolute URL (lowercased), or '' if not absolute.
function qaHost(url) {
  const m = url.match(/^https?:\/\/([^/'"<>\s]+)/i);
  return m ? m[1].toLowerCase() : '';
}

// Attributes on the jcr:content start tag that must never be scanned/fixed: the page
// template, tags, and MSM / language-copy references (cq:master/blueprint/source/live*)
// that legitimately point at another locale's /content path. Everything else on that
// tag — e.g. cardImage, cardTitle — is real authored content (set via the page's field
// model) and must stay scannable, even though it lives as a tag attribute rather than
// inside a child block node.
const PROTECTED_JCR_CONTENT_ATTR_RE =
  /((?:cq:template|cq:tags|cq:master\w*|cq:blueprint\w*|cq:source\w*|cq:live\w*|cq:relativePath)\s*=\s*)("[^"]*"|'[^']*')/g;

// The authored-block region of a Franklin page .content.xml — everything INSIDE
// <jcr:content ...> … </jcr:content>, with the protected attribute VALUES on the
// jcr:content start tag masked out (restored via unmaskProtected() after fixing).
// Only the protected properties are left untouched; the rest of the tag (including
// content fields like cardImage) is scanned/fixed like any other block content.
// Returns { before, region, after, protectedVals } for reassembly; falls back to the
// whole doc when no jcr:content tag is found.
function franklinBlockRegion(xml) {
  const open  = xml.match(/<jcr:content(?:"[^"]*"|'[^']*'|[^>"'])*>/);
  const close = xml.lastIndexOf('</jcr:content>');
  if (!open || close < 0) return { before: '', region: xml, after: '', protectedVals: [] };
  const start = open.index + open[0].length;
  if (close < start) return { before: '', region: xml, after: '', protectedVals: [] };
  const protectedVals = [];
  const maskedOpenTag = open[0].replace(PROTECTED_JCR_CONTENT_ATTR_RE, (m, pre, val) => {
    const token = ` P${protectedVals.length} `;
    protectedVals.push(val);
    return pre + token;
  });
  return {
    before: xml.slice(0, open.index),
    region: maskedOpenTag + xml.slice(start, close),
    after: xml.slice(close),
    protectedVals,
  };
}

// Restore the values masked out by franklinBlockRegion() after the region has been
// scanned/fixed — must be applied to `region`/`body` before reassembly.
function unmaskProtected(text, protectedVals) {
  if (!protectedVals || !protectedVals.length) return text;
  return text.replace(/ P(\d+) /g, (m, i) => protectedVals[Number(i)]);
}

// A DAM asset ref may be written as a bare /content/dam/... path OR as an absolute
// self-link (https://www.abbvie.com/content/dam/...) left over from the legacy site.
// Both forms point at the same asset, so classification/fix/recovery all need to see
// past the optional host prefix. Returns the bare /content/dam/... path, or null.
function damPathOf(url) {
  // Repair segment-leading space / %20 corruption (e.g. "/content/ dam/ abbvie-com2/…"
  // or "/content/%20dam/%20abbvie-com2/…") so mangled DAM refs are still recognized as
  // DAM assets rather than misfiled as cross-locale. Only whitespace/%20 immediately
  // after a "/" is stripped, so genuine spaces inside a filename are preserved.
  const repaired = url.replace(/\/(?:%20|\s)+/gi, '/');
  const m = repaired.match(/^(?:https?:\/\/[^/]+)?(\/content\/dam\/.*)$/i);
  return m ? m[1] : null;
}

// Classify one extracted link for the QA report, given the package site root R.
// dm-ok / internal-ok are correct (not problems); the rest map to the 5 checks
// (+ cross-locale = a full /content path under a different root — valid, review-only).
function qaClassify(url, siteRoot, pageIsLangMaster) {
  if (/delivery-p\d+-e\d+/i.test(url) || /\/adobe\/assets\//i.test(url)) return 'dm-ok';
  if (/\.scene7\.com|\/is\/(?:image|content)\//i.test(url))              return 'scene7';
  const damPath = damPathOf(url);
  if (damPath) {
    const cleanPath = damPath.split('?')[0].split('#')[0]
      .replace(/\/_jcr_content\/renditions\/.*$/, '')
      .replace(/\.coreimg.*$/, '');
    const last = cleanPath.split('/').pop() || '';
    if (!last.includes('.')) return 'dam-cf';                 // extensionless → content fragment / structural node, not a deliverable asset
    return /\.pdf$/i.test(last) ? 'pdf-dam' : 'dam-asset';
  }
  if (/^https?:\/\//i.test(url))                                         return 'absolute';
  if (url.startsWith('/content/')) {
    if (pageIsLangMaster && /\/language-masters\//i.test(url)) return 'internal-ok';   // blueprint PAGE linking to blueprint content is fine; on a live page a language-masters link is still flagged
    return (siteRoot && (url === siteRoot || url.startsWith(siteRoot + '/'))) ? 'internal-ok' : 'cross-locale';
  }
  if (/^\/[a-zA-Z]/.test(url)) return 'short-path';
  return 'other';
}

// Default guess for which absolute domains are "internal" (a migration mistake to fix)
// vs genuinely external. Only the legacy site's own domain is guessed internal by
// default — every other absolute host (careers.abbvie.com, third-party job boards,
// adobeaemcloud.com, etc.) defaults to external. The user can override each in the UI.
const qaGuessInternal = h => /^www\.abbvie\.com$/i.test(h);

// All valid locale roots from site.config.json — both live-copy and blueprint/language-
// masters roots across every locale — deduped and sorted longest-first (most specific
// prefix wins). This is the authoritative source for a cross-locale link's source-locale
// prefix, correctly encoding the 1-vs-2-segment depth variance. Mirrors getDomainForLocale.
function loadLocaleRoots() {
  const { locales = [] } = loadSiteConfig();
  const roots = new Set();
  for (const l of locales) {
    for (const r of [l.liveCopyPath, l.blueprintPath].filter(Boolean)) roots.add(r.replace(/\/$/, ''));
  }
  return [...roots].sort((a, b) => b.length - a.length);
}

// Longest known locale root that prefixes `url`, or null.
function qaSourceRoot(url, localeRoots) {
  for (const root of localeRoots) {
    if (url === root || url.startsWith(root + '/')) return root;
  }
  return null;
}

// ── Analyze: the 5-check migration-QA rollup ──────────────────────────────────
app.post('/api/link-checker/analyze', express.json({ limit: '1mb' }), (req, res) => {
  const { sessionId, siteRoot, env } = req.body;
  const buffer = lcSessions.get(sessionId);
  if (!buffer) return res.status(404).json({ error: 'Session expired — re-upload the ZIP.' });
  if (!siteRoot || !siteRoot.startsWith('/content/')) {
    return res.status(400).json({ error: 'Enter a valid site root, e.g. /content/abbvie-nextgen-eds/corporate/abbvie-com/ch/fr' });
  }
  const R = siteRoot.replace(/\/$/, '');

  try {
    const outer = new AdmZip(buffer);
    const inner = outer.getEntries().find(e => !e.isDirectory && e.entryName.endsWith('.zip'));
    const zip   = inner ? new AdmZip(inner.getData()) : outer;

    const mk = () => ({ count: 0, files: new Set(), examples: [] });
    const checks = { shortPath: mk(), absolute: mk(), pdf: mk(), dam: mk(), scene7: mk() };
    const crossGroups = new Map();       // sourceRoot -> mk()  (cross-locale links grouped by detected source locale)
    const crossUnresolved = mk();        // cross-locale links with no matching config locale → manual
    const localeRoots = loadLocaleRoots();
    const domains = new Map();   // host -> { count, files:Set }
    let pagesScanned = 0, xmlTotal = 0;

    // Load the env asset-map (if any) so we can flag which DAM/PDF/Scene7 refs are unresolved.
    let pathMap = null, scene7Map = null, damNorm = null;
    if (env && fs.existsSync(csvPath(env))) {
      const csvRows = parse(fs.readFileSync(csvPath(env), 'utf8'), { columns: true, skip_empty_lines: true });
      pathMap   = new Map(csvRows.filter(r => r.path && r.openApiUrl).map(r => [r.path, r]));
      scene7Map = buildScene7LookupMap(csvRows);
      const se  = loadSiteConfig().environments.find(e => e.name === env);
      damNorm   = { correctRoot: se?.damRoot || '/content/dam/corporate/abbvie-com2', oldRoots: ['/content/dam/abbvie-com', '/content/dam/abbvie-com2'] };
    }
    const unresolvedAssets = new Map();   // ref -> { current, check, verdict, count }

    const addEx = (c, file, url) => { c.count++; c.files.add(file); c.examples.push({ file, url }); };   // return all (client lists/filters them)

    for (const entry of zip.getEntries()) {
      if (entry.isDirectory || !entry.entryName.endsWith('.xml')) continue;
      xmlTotal++;
      let content;
      try { content = entry.getData().toString('utf8'); } catch { continue; }
      if (!isFranklinPage(content) || lcIsSkipped(entry.entryName)) continue;   // only real pages
      pagesScanned++;
      const file = entry.entryName.replace(/^jcr_root/, '');
      const pageIsLM = /\/language-masters\//i.test(entry.entryName);   // is THIS page a blueprint/language-master page?

      for (const url of extractLinks(franklinBlockRegion(content).region)) {   // authored blocks only, not page-node props
        const kind = qaClassify(url, R, pageIsLM);
        if      (kind === 'scene7')       addEx(checks.scene7, file, url);
        else if (kind === 'pdf-dam')      addEx(checks.pdf, file, url);
        else if (kind === 'dam-asset')    addEx(checks.dam, file, url);
        else if (kind === 'short-path')   addEx(checks.shortPath, file, url);
        else if (kind === 'cross-locale') {
          const S = qaSourceRoot(url, localeRoots);
          if (S) { if (!crossGroups.has(S)) crossGroups.set(S, mk()); addEx(crossGroups.get(S), file, url); }
          else addEx(crossUnresolved, file, url);
        }
        else if (kind === 'absolute') {
          const host = qaHost(url);
          if (!host) continue;
          addEx(checks.absolute, file, url);
          if (!domains.has(host)) domains.set(host, { count: 0, files: new Set() });
          const d = domains.get(host); d.count++; d.files.add(file);
        }

        // Flag DAM/PDF/Scene7 refs the asset-map can't resolve (need a manual DM URL before Fix).
        if (pathMap && (kind === 'scene7' || kind === 'pdf-dam' || kind === 'dam-asset')) {
          const rr = qaResolveLink(url, { R, pathMap, scene7Map, damNorm, pageIsLM, pageLocaleRoot: null, localeRoots });
          if (rr && !rr.newUrl && (rr.cls === 'cant' || rr.cls === 'warn')) {
            if (!unresolvedAssets.has(url)) unresolvedAssets.set(url, { current: url, check: rr.check, verdict: rr.verdict, count: 0 });
            unresolvedAssets.get(url).count++;
          }
        }
      }
    }

    const pack = c => ({ count: c.count, files: c.files.size, examples: c.examples });

    const crossGroupsArr = [...crossGroups.entries()].map(([sourceRoot, c]) => ({
      sourceRoot,
      label: sourceRoot.split('/abbvie-com/')[1] || sourceRoot,   // short locale label, e.g. "us/en" or "language-masters/gr"
      count: c.count, files: c.files.size, examples: c.examples,
    })).sort((a, b) => b.count - a.count);
    const crossFilesSet = new Set();
    for (const c of crossGroups.values()) for (const f of c.files) crossFilesSet.add(f);
    for (const f of crossUnresolved.files) crossFilesSet.add(f);
    const crossCount = crossGroupsArr.reduce((s, g) => s + g.count, 0) + crossUnresolved.count;

    res.json({
      siteRoot: R,
      pagesScanned,
      xmlTotal,
      env: env || '',
      csvExists: env ? fs.existsSync(csvPath(env)) : false,
      checks: {
        shortPath: pack(checks.shortPath),
        absolute:  pack(checks.absolute),
        pdf:       pack(checks.pdf),
        dam:       pack(checks.dam),
        scene7:    pack(checks.scene7),
      },
      domains: [...domains.entries()]
        .map(([host, d]) => ({ host, count: d.count, files: d.files.size, guessInternal: qaGuessInternal(host) }))
        .sort((a, b) => b.count - a.count),
      crossLocale: { count: crossCount, files: crossFilesSet.size, groups: crossGroupsArr, unresolved: pack(crossUnresolved) },
      unresolvedAssets: [...unresolvedAssets.values()].sort((a, b) => b.count - a.count),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── QA fixers (root-driven) ───────────────────────────────────────────────────

// Relative page paths ( /foo/bar , not /content/* or system roots ) → re-rooted to R.
function qaFixShortPaths(xml, R) {
  const SYSTEM = /^\/(content|etc|apps|libs|bin|var|conf|home|crx|jcr|oak|system|mnt|tmp|is)\//i;
  const RE = /([="']|&quot;)(\/[a-zA-Z][a-zA-Z0-9-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)+)/g;
  const changes = [];
  const result = xml.replace(RE, (m, d, p) => {
    if (SYSTEM.test(p)) return m;
    const cleaned = p.replace(/\.html?$/i, '');
    const np = joinWithPrefix(R, cleaned);
    if (np === p) return m;
    changes.push({ oldUrl: p, newUrl: np });
    return d + np;
  });
  return { result, changes };
}

// Cross-locale prefix find & replace. mappings = [{from, to}] sorted desc by from.length.
// For each quoted /content/... page path, the first source root that prefixes it is
// swapped for its target: `to + path.slice(from.length)`. /content/dam and under-R links
// never match a source root, so they're untouched. Runs inside the masked block region.
// The locale-root portion of a /content path — R's own locale suffix OR any
// language-masters/<lang> segment (mirrors the client's lcLocaleRootOf). Used to
// scope a cross-locale mapping to the pages of a given locale.
function qaLocaleRootOf(path, R) {
  const m = R.match(/^(.*\/abbvie-com)\/(.+)$/);
  const localeSuffix = m ? m[2] : R.split('/').filter(Boolean).slice(-2).join('/');
  const esc = localeSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re  = new RegExp('(\\/' + esc + '|\\/language-masters\\/[a-z][a-z0-9-]*)(?=\\/|$)', 'i');
  const mm  = path.match(re);
  return mm ? path.slice(0, mm.index + mm[1].length) : null;
}

// mappings = [{from, to, page?}]. A mapping with `page` applies only to files whose own
// locale root equals `page`; a mapping without `page` applies everywhere.
function qaFixCrossLocale(xml, mappings, pageLocaleRoot) {
  const active = (mappings || []).filter(m => !m.page || m.page === pageLocaleRoot);
  if (!active.length) return { result: xml, changes: [] };
  const changes = [];
  const RE = /([="']|&quot;)(\/content\/[^"'<>&]+)/g;
  const result = xml.replace(RE, (m, d, path) => {
    for (const { from, to } of active) {
      if (path === from || path.startsWith(from + '/')) {
        const np = to + path.slice(from.length);
        if (np === path) return m;
        changes.push({ oldUrl: path, newUrl: np });
        return d + np;
      }
    }
    return m;
  });
  return { result, changes };
}

// Absolute URLs whose host is user-marked-internal → strip host, re-root to R.
// External hosts are left untouched. Embedded /content/dam prefixes are normalized.
function qaFixAbsolute(xml, R, internalHosts, damNorm) {
  if (!internalHosts || internalHosts.size === 0) return { result: xml, changes: [] };
  const changes = [];
  const RE = /([="']|&quot;)(https?:\/\/([^/'"<>\s&]+)([^"'<>\s&]*))/gi;
  const result = xml.replace(RE, (m, d, full, host, tail) => {
    if (!internalHosts.has(host.toLowerCase())) return m;
    let path = (tail || '').replace(/\.html?$/i, '') || '/';
    let np;
    if (path.startsWith('/content/dam/')) np = damNorm ? normalizeDamPrefix(path, damNorm.correctRoot, damNorm.oldRoots) : path;
    else if (path.startsWith('/content/')) np = path;
    else np = joinWithPrefix(R, path);
    changes.push({ oldUrl: full, newUrl: np });
    return d + np;
  });
  return { result, changes };
}

// /content/dam refs and absolute scene7.com URLs → DM Open API URLs, via the asset-map.
// Ported from the Image tool's update-zip: preset/modifier translation, isCF skip,
// DAM prefix normalization. pathMap = path→row(full); scene7Map = key→openApiUrl.
function qaFixAssetRefs(xml, pathMap, scene7Map, damNorm, which, customMap) {
  const w = which || { pdf: true, dam: true, scene7: true };
  const changes = [], unmatched = [];
  const applyParams = (baseUrl, translated, preset) => {
    const out = new URLSearchParams(translated || '');
    if (preset) out.set('preset', preset);
    const qs = out.toString().replace(/&/g, '&amp;');
    return qs ? `${baseUrl}?${qs}` : baseUrl;
  };

  // Delimiter is a real quote/'=' OR an HTML-entity-encoded quote (&quot;) — DAM/PDF refs
  // embedded inside rich-text attributes (e.g. an <a href="..."> inside an RTE `text=`
  // value) are XML-escaped, so the boundary around the path is literally "&quot;", not
  // a bare quote character. '&' is excluded from the path body so that boundary always
  // terminates the match instead of being swallowed into the captured path.
  // The DAM ref itself may carry an optional absolute-host prefix (a legacy hardcoded
  // https://www.abbvie.com/content/dam/... self-link) — matched and replaced whole,
  // same as damPathOf() does for classification/recovery.
  let content = xml.replace(/(["'=]|&quot;)((?:https?:\/\/[^/"'<>&]+)?\/content\/(?:%20|\s)*dam\/[^"'<>&]*)/g, (match, delim, rawUrl) => {
    const qIdx        = rawUrl.indexOf('?');
    const queryString = (qIdx !== -1 ? rawUrl.slice(qIdx + 1) : '').replace(/&amp;/g, '&');
    const presetMatch = queryString.match(/\$([^$]+)\$/);
    const presetName  = presetMatch ? presetMatch[1] : '';
    const modifierStr = queryString.replace(/\$[^$]+\$/g, '').replace(/^&+|&+$/g, '').replace(/&&+/g, '&');
    const translated  = translateModifiers(modifierStr);
    const norm = p => damNorm ? normalizeDamPrefix(p, damNorm.correctRoot, damNorm.oldRoots) : p;
    const base = rawUrl.split('?')[0].split('#')[0]
      .replace(/^https?:\/\/[^/]+/i, '')                      // strip a same-site absolute host prefix, if any
      .replace(/\/_jcr_content\/renditions\/.*$/, '')
      .replace(/\.coreimg.*$/, '');
    // Repair corrupted DAM paths: (1) segment-leading space/%20 ("/content/ dam/…" or
    // "/content/%20dam/…"); (2) if that path isn't in the CSV, treat every stray space/%20
    // as a lost "/" ("…/stories abbvie-…" → "…/stories/abbvie-…"). A genuine filename space
    // (e.g. "Woman standing.jpg") resolves on the first (segment-leading-only) try.
    let cleanPath = norm(base.replace(/\/(?:%20|\s)+/gi, '/'));
    const lastSeg = cleanPath.split('/').pop() || '';
    if (!lastSeg.includes('.')) return match;                // extensionless → content fragment / structural node, never converted
    const isPdf = /\.pdf$/i.test(lastSeg);
    if (isPdf ? !w.pdf : !w.dam) return match;               // this category not selected
    let row = pathMap && pathMap.get(cleanPath);
    if (!row) {
      const alt = norm(base.replace(/(?:%20|\s)+/gi, '/'));
      const altRow = pathMap && pathMap.get(alt);
      if (altRow) { cleanPath = alt; row = altRow; }
    }
    if (row) {
      if (row.isCF === 'true') return match;                      // content fragment — leave unchanged
      if (!/^https?:\/\//i.test(row.openApiUrl)) { unmatched.push(rawUrl); return match; }  // not on DM yet
      const finalUrl = applyParams(row.openApiUrl, translated, presetName);
      changes.push({ oldUrl: rawUrl, newUrl: finalUrl });
      return delim + finalUrl;
    }
    const custom = customMap && (customMap.get(rawUrl) || customMap.get(cleanPath));   // author-supplied DM URL
    if (custom && /^https?:\/\//i.test(custom)) {
      const finalUrl = applyParams(custom, translated, presetName);
      changes.push({ oldUrl: rawUrl, newUrl: finalUrl });
      return delim + finalUrl;
    }
    unmatched.push(rawUrl);
    return match;
  });

  if (w.scene7) content = content.replace(/(["'=]|&quot;)(https?:\/\/[^"'<>\s&]*\.scene7\.com\/is\/(?:image|content)\/([^"'<>\s?&]+)(\?[^"'<>\s&]*)?)/gi, (match, delim, fullUrl, s7Key, qs) => {
    const queryString = (qs ? qs.replace(/^\?/, '') : '').replace(/&amp;/g, '&');
    const presetMatch = queryString.match(/\$([^$]+)\$/);
    const presetName  = presetMatch ? presetMatch[1] : '';
    const modifierStr = queryString.replace(/\$[^$]+\$/g, '').replace(/(?:^|&)ts=[^&]*/g, '').replace(/^&+|&+$/g, '').replace(/&&+/g, '&');
    const translated  = translateModifiers(modifierStr);
    const dmUrl = scene7Map && scene7Map.get(s7Key.trim().toLowerCase());
    if (dmUrl && /^https?:\/\//i.test(dmUrl)) {
      const finalUrl = applyParams(dmUrl, translated, presetName);
      changes.push({ oldUrl: fullUrl, newUrl: finalUrl });
      return delim + finalUrl;
    }
    const custom = customMap && (customMap.get(fullUrl) || customMap.get(s7Key.trim()));   // author-supplied DM URL
    if (custom && /^https?:\/\//i.test(custom)) {
      const finalUrl = applyParams(custom, translated, presetName);
      changes.push({ oldUrl: fullUrl, newUrl: finalUrl });
      return delim + finalUrl;
    }
    unmatched.push(s7Key.trim());
    return match;
  });

  return { result: content, changes, unmatched };
}

// Apply all QA fixes to every Franklin page in the ZIP (nested or flat).
// Order: absolute → asset→DM → short-paths (so each step's output is safe for the next).
async function buildQaFixedZip(buffer, opts) {
  const { siteRoot, internalHosts, pathMap, scene7Map, damNorm, crossLocaleMappings } = opts;
  const sel        = opts.checks || new Set(['shortPath', 'absolute', 'pdf', 'dam', 'scene7']);
  const assetWhich = { pdf: sel.has('pdf'), dam: sel.has('dam'), scene7: sel.has('scene7') };
  const doAsset    = assetWhich.pdf || assetWhich.dam || assetWhich.scene7;
  const customMap  = new Map((opts.customAssetMappings || []).filter(m => m && m.from && m.to).map(m => [m.from, m.to]));
  const outerAdm   = new AdmZip(buffer);
  const innerEntry = outerAdm.getEntries().find(e => !e.isDirectory && e.entryName.endsWith('.zip'));
  const changes = [], unmatched = [];
  let pagesFixed = 0;

  async function patch(adm) {
    const jsz = new JSZip();
    for (const e of adm.getEntries()) {
      if (e.isDirectory) continue;
      const name = e.entryName;
      if (name.endsWith('.xml') && !lcIsSkipped(name)) {
        const before = e.getData().toString('utf8');
        if (isFranklinPage(before)) {
          const file = name.replace(/^jcr_root/, '');
          const { before: pre, region, after: post, protectedVals } = franklinBlockRegion(before);
          let body = region;   // fix authored blocks + content fields; cq:template/tags/MSM refs stay masked
          const a = sel.has('absolute') ? qaFixAbsolute(body, siteRoot, internalHosts, damNorm) : { result: body, changes: [] };            body = a.result;
          const b = doAsset             ? qaFixAssetRefs(body, pathMap, scene7Map, damNorm, assetWhich, customMap) : { result: body, changes: [], unmatched: [] }; body = b.result;
          const c = sel.has('shortPath') ? qaFixShortPaths(body, siteRoot) : { result: body, changes: [] };                                  body = c.result;
          const pageLocale = qaLocaleRootOf(file, siteRoot);
          const x = (sel.has('crossLocale') && crossLocaleMappings?.length) ? qaFixCrossLocale(body, crossLocaleMappings, pageLocale) : { result: body, changes: [] }; body = x.result;
          body = unmaskProtected(body, protectedVals);   // restore cq:template/tags/MSM refs before writing back
          const after = pre + body + post;
          for (const ch of a.changes) changes.push({ file, type: 'absolute',     ...ch });
          for (const ch of b.changes) changes.push({ file, type: 'asset-dm',     ...ch });
          for (const ch of c.changes) changes.push({ file, type: 'short-path',   ...ch });
          for (const ch of x.changes) changes.push({ file, type: 'cross-locale', ...ch });
          for (const u  of b.unmatched) unmatched.push({ file, url: u });
          if (after !== before) pagesFixed++;
          jsz.file(name, after);
          continue;
        }
      }
      jsz.file(name, e.getData());
    }
    return jsz.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  if (innerEntry) {
    const patchedInner = await patch(new AdmZip(innerEntry.getData()));
    const outerJsz = new JSZip();
    for (const e of outerAdm.getEntries()) {
      if (e.isDirectory) continue;
      outerJsz.file(e.entryName, e.entryName === innerEntry.entryName ? patchedInner : e.getData());
    }
    return { buf: await outerJsz.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), changes, unmatched, pagesFixed };
  }
  return { buf: await patch(outerAdm), changes, unmatched, pagesFixed };
}

// Pre-scan pass for the Fix flow: walks the Franklin pages (same inner/outer zip
// handling as buildQaFixedZip) and returns the deduped list of /content/dam/ paths
// that qaFixAssetRefs would otherwise report as unmatched — either missing from
// pathMap entirely, or present but without a real DM URL yet. The path cleaning
// (strip query/hash/rendition/coreimg suffix, then normalizeDamPrefix) mirrors
// qaFixAssetRefs exactly so a path recovered here lands under the same pathMap key
// qaFixAssetRefs will look up on this same Fix pass.
function collectUnresolvedDamPaths(buffer, pathMap, damNorm, which) {
  const outerAdm   = new AdmZip(buffer);
  const innerEntry = outerAdm.getEntries().find(e => !e.isDirectory && e.entryName.endsWith('.zip'));
  const zip        = innerEntry ? new AdmZip(innerEntry.getData()) : outerAdm;
  const found      = new Set();

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.entryName.endsWith('.xml') || lcIsSkipped(entry.entryName)) continue;
    let content;
    try { content = entry.getData().toString('utf8'); } catch { continue; }
    if (!isFranklinPage(content)) continue;

    for (const url of extractLinks(franklinBlockRegion(content).region)) {
      const damPath = damPathOf(url);
      if (!damPath) continue;
      let cleanPath = damPath.split('?')[0].split('#')[0]
        .replace(/\/_jcr_content\/renditions\/.*$/, '')
        .replace(/\.coreimg.*$/, '');
      if (damNorm) cleanPath = normalizeDamPrefix(cleanPath, damNorm.correctRoot, damNorm.oldRoots);
      const lastSeg = cleanPath.split('/').pop() || '';
      if (!lastSeg.includes('.')) continue;                 // extensionless → content fragment / structural node
      const isPdf = /\.pdf$/i.test(lastSeg);
      if (isPdf ? !which.pdf : !which.dam) continue;
      const row = pathMap?.get(cleanPath);
      if (!row || !/^https?:\/\//i.test(row.openApiUrl)) found.add(cleanPath);
    }
  }
  return [...found];
}

// ── Fix: apply the QA fixes and return the patched ZIP + change report ────────
app.post('/api/link-checker/fix', express.json({ limit: '2mb' }), async (req, res) => {
  const { sessionId, siteRoot, env, internalDomains, checks } = req.body;
  const buffer = lcSessions.get(sessionId);
  if (!buffer) return res.status(404).json({ error: 'Session expired — re-upload the ZIP.' });
  if (!siteRoot || !siteRoot.startsWith('/content/')) return res.status(400).json({ error: 'Enter a valid site root.' });
  const R = siteRoot.replace(/\/$/, '');
  const internalHosts = new Set((internalDomains || []).map(h => String(h).toLowerCase()));
  const sel      = new Set(Array.isArray(checks) && checks.length ? checks : ['shortPath', 'absolute', 'pdf', 'dam', 'scene7']);
  const needsCsv = sel.has('pdf') || sel.has('dam') || sel.has('scene7');

  // Cross-locale prefix mappings: [{from, to}] — both must be /content/ paths. Longest source first.
  const crossLocaleMappings = (Array.isArray(req.body.crossLocaleMappings) ? req.body.crossLocaleMappings : [])
    .filter(m => m && typeof m.from === 'string' && typeof m.to === 'string' && m.from.startsWith('/content/') && m.to.startsWith('/content/'))
    .map(m => ({ from: m.from.replace(/\/$/, ''), to: m.to.replace(/\/$/, ''),
                 page: (typeof m.page === 'string' && m.page.startsWith('/content/')) ? m.page.replace(/\/$/, '') : '' }))
    .sort((a, b) => b.from.length - a.from.length);
  if (sel.has('crossLocale') && !crossLocaleMappings.length) {
    return res.status(400).json({ error: 'No cross-locale groups selected (tick a group and enter a target path).' });
  }

  // Author-supplied asset mappings: [{from, to}] — from = the asset ref as found, to = a DM URL.
  // Used when the asset-map CSV has no entry for a reference.
  const customAssetMappings = (Array.isArray(req.body.customAssetMappings) ? req.body.customAssetMappings : [])
    .filter(m => m && typeof m.from === 'string' && typeof m.to === 'string' && m.from && /^https?:\/\//i.test(m.to));

  try {
    let pathMap = null, scene7Map = null, damNorm = null, se = null;
    if (needsCsv) {
      if (env && fs.existsSync(csvPath(env))) {
        const rows = parse(fs.readFileSync(csvPath(env), 'utf8'), { columns: true, skip_empty_lines: true });
        pathMap   = new Map(rows.filter(r => r.path && r.openApiUrl).map(r => [r.path, r]));
        scene7Map = buildScene7LookupMap(rows);
        se        = loadSiteConfig().environments.find(e => e.name === env);
      } else if (!customAssetMappings.length) {
        return res.status(400).json({ error: env
          ? `No asset-map CSV for environment "${env}". Build it in the Image/Asset tool first, or add custom asset mappings.`
          : 'Select a target environment (or add custom asset mappings) for PDF / DAM / Scene7 → DM conversion.' });
      }
      damNorm = { correctRoot: se?.damRoot || '/content/dam/corporate/abbvie-com2', oldRoots: ['/content/dam/abbvie-com', '/content/dam/abbvie-com2'] };
    }

    // Live AEM-author recovery: for any PDF/DAM ref the CSV can't resolve to a DM
    // URL (missing row, or crawled before the asset was approved), check the asset
    // directly on this environment's AEM author. A confirmed hit is written into
    // `pathMap` (picked up by buildQaFixedZip below, same pass) and persisted back
    // into the asset-map CSV so future Fix runs don't need to re-check AEM.
    let recoveredPaths = new Set();
    if (needsCsv && pathMap && (sel.has('pdf') || sel.has('dam'))) {
      const candidates = collectUnresolvedDamPaths(buffer, pathMap, damNorm, { pdf: sel.has('pdf'), dam: sel.has('dam') });
      if (candidates.length) {
        const recovered = await recoverDmUrlsFromAuthor(candidates, pathMap, {
          aemUrl: se?.aemUrl, dmHost: se?.dmHost,
          username: appConfig?.target?.username, password: appConfig?.target?.password,
        }, msg => console.log('[link-checker fix]', msg));
        if (recovered.length) {
          persistRecoveredRows(env, recovered);
          recoveredPaths = new Set(recovered.map(r => r.path));
        }
      }
    }

    const { buf, changes, unmatched, pagesFixed } = await buildQaFixedZip(buffer, { siteRoot: R, internalHosts, pathMap, scene7Map, damNorm, checks: sel, crossLocaleMappings, customAssetMappings });
    lcSessions.set(sessionId, buf);   // keep session, chained on the fixed result (enables per-category iteration + re-scan)

    const reportRows = changes.map(c => ({
      file: c.file, type: c.type,
      status: recoveredPaths.has(c.oldUrl.split('?')[0].split('#')[0]) ? 'changed (recovered from AEM author)' : 'changed',
      oldUrl: c.oldUrl, newUrl: c.newUrl,
    }));
    for (const u of unmatched) reportRows.push({ file: u.file, type: 'asset-dm', status: 'unmatched (no CSV entry)', oldUrl: u.url, newUrl: '' });
    const reportCsv = stringify(reportRows, { header: true, columns: [
      { key: 'file', header: 'file' }, { key: 'type', header: 'type' }, { key: 'status', header: 'status' },
      { key: 'oldUrl', header: 'old_url' }, { key: 'newUrl', header: 'new_url' },
    ] });
    const reportId = randomUUID();
    lcReports.set(reportId, reportCsv);
    setTimeout(() => lcReports.delete(reportId), 15 * 60 * 1000).unref?.();

    const counts = changes.reduce((a, c) => (a[c.type] = (a[c.type] || 0) + 1, a), {});
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="qa-fixed-package.zip"');
    res.setHeader('X-Pages-Fixed',  String(pagesFixed));
    res.setHeader('X-Change-Count', String(changes.length));
    res.setHeader('X-Unmatched',    String(unmatched.length));
    res.setHeader('X-Recovered',    String(recoveredPaths.size));
    res.setHeader('X-Counts',       Buffer.from(JSON.stringify(counts)).toString('base64'));
    res.setHeader('X-Report-Id',    reportId);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Check ZIP ─────────────────────────────────────────────────────────────────
app.post('/api/link-checker/check', (req, res, next) => {
  upload.single('zip')(req, res, err => {
    if (err) return res.json({ success: false, error: `Upload error: ${err.message}` });
    next();
  });
}, (req, res) => {
  if (!req.file) return res.json({ success: false, error: 'No ZIP file uploaded.' });

  try {
    const outerZip      = new AdmZip(req.file.buffer);
    const innerZipEntry = outerZip.getEntries().find(e => !e.isDirectory && e.entryName.endsWith('.zip'));
    const workingZip    = innerZipEntry ? new AdmZip(innerZipEntry.getData()) : outerZip;

    const TYPE_KEYS    = ['dam', 'internal', 'external', 'scene7', 'dm-openapi', 'aem-cloud', 'abbvie-abs', 'short-path', 'other'];
    const globalCounts = Object.fromEntries(TYPE_KEYS.map(k => [k, 0]));
    let totalLinks = 0;
    const files    = [];

    for (const entry of workingZip.getEntries()) {
      if (entry.isDirectory || !entry.entryName.endsWith('.xml')) continue;
      let content;
      try { content = entry.getData().toString('utf8'); } catch { continue; }

      const rawLinks = extractLinks(content);
      if (!rawLinks.length) continue;

      const counts = Object.fromEntries(TYPE_KEYS.map(k => [k, 0]));
      const links  = rawLinks.map(url => {
        const type = classifyLink(url);
        counts[type]++;
        globalCounts[type]++;
        return { url, type };
      });

      totalLinks += links.length;
      files.push({ file: entry.entryName, linkCount: links.length, counts, links });
    }

    files.sort((a, b) => b.linkCount - a.linkCount);

    const sessionId = randomUUID();
    lcSessions.set(sessionId, req.file.buffer);

    res.json({
      success: true,
      sessionId,
      stats: { totalFiles: files.length, totalLinks, byType: globalCounts },
      files,
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── Detect site root and locales from ZIP ─────────────────────────────────────
app.post('/api/link-checker/detect-root', express.json({ limit: '1mb' }), (req, res) => {
  const buffer = lcSessions.get(req.body.sessionId);
  if (!buffer) return res.status(404).json({ error: 'Session expired — re-upload the ZIP.' });
  try {
    const outer = new AdmZip(buffer);
    const inner = outer.getEntries().find(e => !e.isDirectory && e.entryName.endsWith('.zip'));
    const zip   = inner ? new AdmZip(inner.getData()) : outer;
    res.json(detectSiteInfo(zip));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// HEAD-check each rewritten URL against AEM to flag 404s. Mutates reportRows
// (adds `headStatus`). cfg = { aemHost, username, password } or null to skip.
async function headCheckReport(reportRows, cfg) {
  if (!cfg || !cfg.aemHost) {
    for (const r of reportRows) r.headStatus = r.newUrl ? 'not checked' : '';
    return { checked: 0, notFound: 0, errors: 0 };
  }
  const base = cfg.aemHost.replace(/\/$/, '');

  // Map a rewritten URL to an absolute, fetchable URL (+ whether AEM auth applies).
  //  absolute (DM delivery)        → as-is, no auth
  //  /content/dam/... (asset)      → authHost + path
  //  /content/... (page)           → authHost + path + .html  (renders the page node)
  const toTarget = u => {
    if (!u) return null;
    if (/^https?:\/\//i.test(u)) return { url: u, auth: false };
    if (u.startsWith('/content/dam/')) return { url: base + encodeURI(u),          auth: true };
    if (u.startsWith('/content/'))     return { url: base + encodeURI(u) + '.html', auth: true };
    return null;
  };

  const cache = new Map();
  const headOne = async (newUrl) => {
    const t = toTarget(newUrl);
    if (!t) { cache.set(newUrl, 'not checkable'); return; }
    const opts = { timeout: 8000, maxRedirects: 0, httpsAgent, validateStatus: () => true };
    if (t.auth) opts.auth = { username: cfg.username || '', password: cfg.password || '' };
    try {
      let resp = await axios.head(t.url, opts);
      if (resp.status === 405) resp = await axios.get(t.url, { ...opts, headers: { Range: 'bytes=0-0' } }); // server rejects HEAD
      cache.set(newUrl, String(resp.status));
    } catch (err) {
      cache.set(newUrl, `ERR ${(err.code || err.message || 'failed')}`.slice(0, 40));
    }
  };

  const jobs = [...new Set(reportRows.map(r => r.newUrl).filter(Boolean))];
  const CONC = 15;
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(CONC, jobs.length) }, async () => {
    while (idx < jobs.length) { const j = jobs[idx++]; await headOne(j); }
  }));

  let notFound = 0, errors = 0;
  for (const r of reportRows) {
    r.headStatus = r.newUrl ? (cache.get(r.newUrl) || 'not checked') : '';
    if (r.headStatus === '404') notFound++;
    else if (r.headStatus.startsWith('ERR')) errors++;
  }
  return { checked: jobs.length, notFound, errors };
}

// ── Migration QA report: per-reference verdict (dry-run of the fixers) ─────────
// Returns { check, newUrl, verdict, cls } for one link, or null if it's a correct
// internal link / not a reportable reference. cls ∈ fix|ok|warn|cant|skip.
function qaResolveLink(url, ctx) {
  const { R, pathMap, scene7Map, damNorm, pageIsLM, pageLocaleRoot, localeRoots } = ctx;
  const norm = p => damNorm ? normalizeDamPrefix(p, damNorm.correctRoot, damNorm.oldRoots) : p;
  const kind = qaClassify(url, R, pageIsLM);

  if (kind === 'dm-ok')  return { check: 'dm',               newUrl: '', verdict: 'already on DM',    cls: 'ok'   };
  if (kind === 'dam-cf') return { check: 'content-fragment', newUrl: '', verdict: 'kept as DAM path', cls: 'skip' };

  if (kind === 'scene7') {
    const m = url.match(/\/is\/(?:image|content)\/([^?"'<>\s]+)/i);
    const dm = m && scene7Map ? scene7Map.get(m[1].trim().toLowerCase()) : null;
    if (dm && /^https?:\/\//i.test(dm)) return { check: 'scene7', newUrl: dm, verdict: 'convertible', cls: 'fix' };
    return { check: 'scene7', newUrl: '', verdict: 'not in asset-map', cls: 'cant' };
  }

  if (kind === 'pdf-dam' || kind === 'dam-asset') {
    const check = kind === 'pdf-dam' ? 'pdf' : 'dam-asset';
    const corrupted = /(?:%20|\s)/.test(url);
    const damPath = damPathOf(url);
    if (!damPath || !pathMap) return { check, newUrl: '', verdict: 'not in asset-map', cls: 'cant' };
    const base = damPath.split('?')[0].split('#')[0].replace(/\/_jcr_content\/renditions\/.*$/, '').replace(/\.coreimg.*$/, '');
    let row = pathMap.get(norm(base)) || pathMap.get(norm(base.replace(/(?:%20|\s)+/gi, '/')));
    if (!row) return { check, newUrl: '', verdict: 'not in asset-map', cls: 'cant' };
    if (row.isCF === 'true') return { check: 'content-fragment', newUrl: '', verdict: 'kept as DAM path', cls: 'skip' };
    if (!/^https?:\/\//i.test(row.openApiUrl)) return { check, newUrl: '', verdict: 'unapproved — no DM URL', cls: 'warn' };
    return { check, newUrl: row.openApiUrl, verdict: corrupted ? 'corrupted path — repaired' : 'convertible', cls: corrupted ? 'warn' : 'fix' };
  }

  if (kind === 'absolute') {
    const host = qaHost(url);
    if (qaGuessInternal(host)) {
      const tail = (url.replace(/^https?:\/\/[^/]+/i, '').replace(/\.html?$/i, '') || '/');
      return { check: 'absolute', newUrl: tail.startsWith('/content/') ? tail : joinWithPrefix(R, tail), verdict: 'will fix', cls: 'fix' };
    }
    return { check: 'absolute', newUrl: '', verdict: 'external — kept', cls: 'skip' };
  }

  if (kind === 'short-path') return { check: 'short-path', newUrl: joinWithPrefix(R, url.replace(/\.html?$/i, '')), verdict: 'will fix', cls: 'fix' };

  if (kind === 'cross-locale') {
    const src = qaSourceRoot(url, localeRoots) || qaLocaleRootOf(url, R);
    if (!src) return { check: 'cross-locale', newUrl: '', verdict: 'review — no source root', cls: 'warn' };
    return { check: 'cross-locale', newUrl: (pageLocaleRoot || R) + url.slice(src.length), verdict: 'will fix (default target)', cls: 'fix' };
  }

  return null;   // internal-ok / other → correct or not a reportable reference
}

app.post('/api/link-checker/report', express.json({ limit: '1mb' }), (req, res) => {
  const { sessionId, siteRoot, env } = req.body;
  const buffer = lcSessions.get(sessionId);
  if (!buffer) return res.status(404).json({ error: 'Session expired — re-upload the ZIP.' });
  if (!siteRoot || !siteRoot.startsWith('/content/')) return res.status(400).json({ error: 'Enter a valid site root.' });
  const R = siteRoot.replace(/\/$/, '');

  try {
    let pathMap = null, scene7Map = null, damNorm = null;
    if (env && fs.existsSync(csvPath(env))) {
      const rows = parse(fs.readFileSync(csvPath(env), 'utf8'), { columns: true, skip_empty_lines: true });
      pathMap   = new Map(rows.filter(r => r.path && r.openApiUrl).map(r => [r.path, r]));
      scene7Map = buildScene7LookupMap(rows);
      const se  = loadSiteConfig().environments.find(e => e.name === env);
      damNorm   = { correctRoot: se?.damRoot || '/content/dam/corporate/abbvie-com2', oldRoots: ['/content/dam/abbvie-com', '/content/dam/abbvie-com2'] };
    }
    const localeRoots = loadLocaleRoots();

    const outer = new AdmZip(buffer);
    const inner = outer.getEntries().find(e => !e.isDirectory && e.entryName.endsWith('.zip'));
    const zip   = inner ? new AdmZip(inner.getData()) : outer;

    const agg = new Map();
    const summary = { fix: 0, ok: 0, warn: 0, cant: 0, skip: 0 };
    let pagesScanned = 0;
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory || !entry.entryName.endsWith('.xml')) continue;
      let content; try { content = entry.getData().toString('utf8'); } catch { continue; }
      if (!isFranklinPage(content) || lcIsSkipped(entry.entryName)) continue;
      pagesScanned++;
      const file = entry.entryName.replace(/^jcr_root/, '');
      const ctx = { R, pathMap, scene7Map, damNorm, pageIsLM: /\/language-masters\//i.test(entry.entryName), pageLocaleRoot: qaLocaleRootOf(file, R), localeRoots };
      for (const url of extractLinks(franklinBlockRegion(content).region)) {
        const r = qaResolveLink(url, ctx);
        if (!r) continue;
        summary[r.cls]++;
        const key = r.check + '|' + url + '|' + r.newUrl + '|' + r.verdict;
        if (!agg.has(key)) agg.set(key, { check: r.check, current: url, newUrl: r.newUrl, verdict: r.verdict, cls: r.cls, count: 0, pages: new Set() });
        const a = agg.get(key); a.count++; a.pages.add(file);
      }
    }

    const order = { cant: 0, warn: 1, fix: 2, skip: 3, ok: 4 };
    const rows = [...agg.values()]
      .map(a => ({ check: a.check, current: a.current, newUrl: a.newUrl, verdict: a.verdict, cls: a.cls, count: a.count, files: a.pages.size, sample: [...a.pages].slice(0, 3) }))
      .sort((x, y) => (order[x.cls] - order[y.cls]) || (y.count - x.count));

    res.json({ siteRoot: R, env: env || '', csvExists: !!pathMap, pagesScanned, summary, total: rows.length, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Download the change report from the last fix ──────────────────────────────
app.get('/api/link-checker/fix-report/:id', (req, res) => {
  const csv = lcReports.get(req.params.id);
  if (!csv) return res.status(404).json({ error: 'Report expired or not found — re-run the fix.' });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="fix-change-report.csv"');
  res.send(csv);
});

// ══════════════════════════════════════════════════════════════════════════════
// PACKAGE CREATOR TOOL  (/api/pkg/*)
// Bulk-create AEM content package filters via the Package Manager API.
// ══════════════════════════════════════════════════════════════════════════════

const FormData = require('form-data');

function pkgClient(host, username, password) {
  return axios.create({
    baseURL: host.replace(/\/$/, ''),
    auth: { username, password },
    timeout: 30000,
    httpsAgent,                       // tolerate self-signed AEM certs (matches the rest of the suite)
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
}

async function pkgTestConnection(host, username, password) {
  const client = pkgClient(host, username, password);
  const res = await client.get('/crx/packmgr/service.jsp?cmd=ls');
  return res.status === 200;
}

async function pkgCreatePackage(host, username, password, { packageName, groupName, version, description }) {
  const client = pkgClient(host, username, password);
  const form = new FormData();
  form.append('packageName', packageName);
  form.append('groupName', groupName);
  if (version)     form.append('packageVersion', version);
  if (description) form.append('packageDescription', description);

  const res = await client.post(
    '/crx/packmgr/service/.json/etc/packages/tmp.zip?cmd=create',
    form,
    { headers: form.getHeaders() }
  );
  return res.data;
}

// Each filter: { root: '/content/...', mode: 'replace'|'merge'|'update', rules: [] }
async function pkgUpdateFilters(host, username, password, packagePath, filters, packageDetails) {
  const client = pkgClient(host, username, password);
  const filterPayload = filters.map(({ root, mode, rules }) => ({
    root,
    mode: mode || 'replace',
    rules: rules || [],
  }));

  const form = new FormData();
  form.append('path', packagePath);
  // update.jsp needs these to match the existing package, else it errors "Illegal package name"
  form.append('packageName', packageDetails.packageName);
  form.append('groupName',   packageDetails.groupName);
  form.append('version',     packageDetails.version || '1.0');
  form.append('filter', JSON.stringify(filterPayload));

  const res = await client.post('/crx/packmgr/update.jsp', form, { headers: form.getHeaders() });
  return res.data;
}

async function pkgBuildPackage(host, username, password, packagePath) {
  const client = pkgClient(host, username, password);
  const res = await client.post(`/crx/packmgr/service/.json${packagePath}?cmd=build`);
  return res.data;
}

// ── Test connection ───────────────────────────────────────────────────────────
app.post('/api/pkg/test-connection', express.json(), async (req, res) => {
  const { host, username, password } = req.body;
  try {
    await pkgTestConnection(host, username, password);
    res.json({ success: true, message: 'Connected successfully' });
  } catch (err) {
    const status = err.response?.status;
    const detail = err.message || err.code || 'unreachable host';
    const msg = status === 401 ? 'Invalid credentials (401 Unauthorized)'
              : status === 404 ? 'AEM Package Manager not found — check host URL'
              : `Connection failed: ${detail}`;
    res.json({ success: false, message: msg });
  }
});

// ── Create package (+ filters, optional build) — streams NDJSON progress ──────
app.post('/api/pkg/create-package', express.json(), async (req, res) => {
  const { host, username, password, packageDetails, filters, build } = req.body;

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  const send = (step, status, message) => res.write(JSON.stringify({ step, status, message }) + '\n');

  // Step 1: create
  let packagePath;
  send('create', 'running', `Creating package "${packageDetails.packageName}"…`);
  try {
    const r = await pkgCreatePackage(host, username, password, packageDetails);
    if (r.success === false) throw new Error(r.msg || 'Create failed');
    if (!r.path) throw new Error('AEM did not return a package path');
    packagePath = r.path;
    send('create', 'done', `Package created at ${packagePath}`);
  } catch (err) {
    send('create', 'error', err.response?.data?.msg || err.message || err.code || "Request failed");
    return res.end();
  }

  // Step 2: filters
  send('filters', 'running', `Applying ${filters.length} filter(s)…`);
  try {
    const r = await pkgUpdateFilters(host, username, password, packagePath, filters, packageDetails);
    if (r.success === false) throw new Error(r.msg || 'Filter update failed');
    send('filters', 'done', `${filters.length} filter(s) applied`);
  } catch (err) {
    send('filters', 'error', err.response?.data?.msg || err.message || err.code || "Request failed");
    return res.end();
  }

  // Step 3: build (optional)
  if (build) {
    send('build', 'running', 'Building package…');
    try {
      const r = await pkgBuildPackage(host, username, password, packagePath);
      if (r.success === false) throw new Error(r.msg || 'Build failed');
      send('build', 'done', 'Package built and ready to install');
    } catch (err) {
      send('build', 'error', err.response?.data?.msg || err.message || err.code || "Request failed");
      return res.end();
    }
  }

  send('done', 'done', `${host.replace(/\/$/, '')}/crx/packmgr/index.jsp#${packagePath}`);
  res.end();
});

// ══════════════════════════════════════════════════════════════════════════════
// XMOD S7 PACKAGE UPDATER TOOL  (/api/pkg-updater/*)
// Ported from the standalone package-updater.js CLI. Two independent operations
// on an AEM content-package ZIP: (1) asset reference replacement via
// asset-mapping.json, (2) content path move (auto-detected from filter.xml).
// ══════════════════════════════════════════════════════════════════════════════

const puSessions = new Map();   // sessionId → { buffer } from the last upload; 15-min TTL

function puNormalizeArchivePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\/+/, '');
}

function puNormalizeJcrPath(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!normalized || normalized === '/') return normalized;
  return normalized.replace(/\/+$/, '');
}

function puGetEntryByName(zip, expectedName) {
  const expected = puNormalizeArchivePath(expectedName);
  return zip.getEntries().find(e => puNormalizeArchivePath(e.entryName) === expected) || null;
}

const puGetZipEntryName = entry => puNormalizeArchivePath(entry.entryName);

function puIsBinary(buffer) {
  for (let i = 0; i < Math.min(buffer.length, 512); i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function puApplyTextReplacements(content, replacements) {
  let result = content;
  for (const [from, to] of replacements) result = result.split(from).join(to);
  return result;
}

function puSanitizeXmlAmpersands(content) {
  return content.replace(/&(?!(?:#x[\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);)/g, '&amp;');
}

const puIsXmlFile = name => name.toLowerCase().endsWith('.xml');

function puBuildAssetReplacements(mappingBuffer) {
  const mapping = JSON.parse(mappingBuffer.toString('utf8'));
  return Object.entries(mapping).map(([url, damPath]) => [damPath, url]);
}

function puDetectSourcePath(zip) {
  const filterEntry = puGetEntryByName(zip, 'META-INF/vault/filter.xml');
  if (!filterEntry) return null;
  const xml = filterEntry.getData().toString('utf8');
  const roots = [...xml.matchAll(/root="([^"]+)"/g)].map(m => puNormalizeJcrPath(m[1]));
  if (!roots.length) return null;

  const parts = roots[0].split('/').filter(Boolean);
  let common = [];
  for (let depth = 1; depth <= parts.length; depth++) {
    const prefix = `/${parts.slice(0, depth).join('/')}`;
    if (roots.every(root => root === prefix || root.startsWith(`${prefix}/`))) common = parts.slice(0, depth);
    else break;
  }
  return common.length ? `/${common.join('/')}` : null;
}

function puIntermediateContentXml(childName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<jcr:root xmlns:jcr="http://www.jcp.org/jcr/1.0" xmlns:cq="http://www.day.com/jcr/cq/1.0"
    jcr:primaryType="cq:Page">
    <jcr:content/>
    <${childName}/>
</jcr:root>`;
}

function puGetIntermediateNodes(sourcePath, targetPath) {
  if (!targetPath.startsWith(`${sourcePath}/`)) return [];
  const suffix = targetPath.slice(sourcePath.length + 1);
  const segments = suffix.split('/').filter(Boolean);
  const nodes = [];
  for (let i = 0; i < segments.length - 1; i++) {
    const nodeDir = `jcr_root${sourcePath}/${segments.slice(0, i + 1).join('/')}`;
    nodes.push({ zipPath: `${nodeDir}/.content.xml`, child: segments[i + 1] });
  }
  return nodes;
}

// Returns { outputZip, modifiedCount, log }
function puProcessContentZip(zip, assetReplacements, sourcePath, targetPath) {
  const output = new AdmZip();
  const log = [];
  const srcJcr = sourcePath ? `jcr_root${sourcePath}` : null;
  const tgtJcr = targetPath ? `jcr_root${targetPath}` : null;
  const doMove = srcJcr && tgtJcr && srcJcr !== tgtJcr;
  const allReplacements = [...assetReplacements];
  if (doMove) allReplacements.push([sourcePath, targetPath]);
  allReplacements.sort((a, b) => b[0].length - a[0].length);

  let modifiedCount = 0;

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;

    let entryName = puGetZipEntryName(entry);
    if (doMove && entryName.startsWith(`${srcJcr}/`)) {
      entryName = tgtJcr + entryName.slice(srcJcr.length);
    }

    const buffer = entry.getData();
    if (puIsBinary(buffer)) {
      output.addFile(entryName, buffer);
      continue;
    }

    const original = buffer.toString('utf8');
    let updated = puApplyTextReplacements(original, allReplacements);

    if (puIsXmlFile(entryName)) {
      const sanitized = puSanitizeXmlAmpersands(updated);
      if (sanitized !== updated) { log.push(`Sanitized: ${entryName} (escaped bare & in XML)`); updated = sanitized; }
    }

    if (updated !== original) { modifiedCount++; log.push(`Modified : ${entryName}`); }
    output.addFile(entryName, Buffer.from(updated, 'utf8'));
  }

  if (doMove) {
    for (const { zipPath, child } of puGetIntermediateNodes(sourcePath, targetPath)) {
      if (!puGetEntryByName(zip, zipPath) && !puGetEntryByName(output, zipPath)) {
        log.push(`Created  : ${zipPath} (intermediate node for <${child}/>)`);
        output.addFile(zipPath, Buffer.from(puIntermediateContentXml(child), 'utf8'));
        modifiedCount++;
      }
    }
  }

  return { outputZip: output, modifiedCount, log };
}

function puIsBundle(zip) {
  return !!puGetEntryByName(zip, 'asset-mapping.json') &&
    zip.getEntries().some(e => !e.isDirectory && puGetZipEntryName(e).toLowerCase().endsWith('.zip'));
}

// Resolve the content zip + asset replacements from an uploaded buffer.
// `extraMappingBuffer` (optional) lets a plain content zip also get asset replacement.
function puResolveInputs(buffer, extraMappingBuffer) {
  const outerZip = new AdmZip(buffer);
  const bundle = puIsBundle(outerZip);

  let mappingBuffer = null;
  let contentZip, innerZipName;

  if (bundle) {
    mappingBuffer = puGetEntryByName(outerZip, 'asset-mapping.json').getData();
    const innerEntry = outerZip.getEntries().find(
      e => !e.isDirectory && puGetZipEntryName(e).toLowerCase().endsWith('.zip')
    );
    innerZipName = puGetZipEntryName(innerEntry);
    contentZip = new AdmZip(innerEntry.getData());
  } else {
    contentZip = outerZip;
    innerZipName = null;
    if (extraMappingBuffer) mappingBuffer = extraMappingBuffer;
  }

  const assetReplacements = mappingBuffer ? puBuildAssetReplacements(mappingBuffer) : [];
  return { bundle, mappingBuffer, contentZip, innerZipName, assetReplacements };
}

// ── Inspect: upload ZIP, report bundle status / source path / mapping count ───
app.post('/api/pkg-updater/inspect', (req, res, next) => {
  upload.fields([{ name: 'zip', maxCount: 1 }, { name: 'mapping', maxCount: 1 }])(req, res, err => {
    if (err) return res.json({ success: false, error: `Upload error: ${err.message}` });
    next();
  });
}, (req, res) => {
  const zipFile = req.files?.zip?.[0];
  if (!zipFile) return res.json({ success: false, error: 'No ZIP file uploaded.' });
  try {
    const extraMapping = req.files?.mapping?.[0]?.buffer || null;
    const { bundle, contentZip, innerZipName, assetReplacements } = puResolveInputs(zipFile.buffer, extraMapping);
    const sourcePath = puDetectSourcePath(contentZip);

    const sessionId = randomUUID();
    puSessions.set(sessionId, { buffer: zipFile.buffer, mapping: extraMapping });
    setTimeout(() => puSessions.delete(sessionId), 15 * 60 * 1000).unref?.();

    res.json({
      success: true,
      sessionId,
      isBundle: bundle,
      innerZipName,
      assetCount: assetReplacements.length,
      sourcePath,
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── Process: apply asset replacement + optional path move, return updated ZIP ─
app.post('/api/pkg-updater/process', express.json({ limit: '1mb' }), async (req, res) => {
  const { sessionId, targetPath: rawTarget } = req.body;
  const session = puSessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session expired — re-upload the ZIP.' });

  try {
    const { bundle, mappingBuffer, contentZip, innerZipName, assetReplacements } =
      puResolveInputs(session.buffer, session.mapping);

    let sourcePath = null;
    let targetPath = rawTarget ? puNormalizeJcrPath(rawTarget) : null;

    if (targetPath) {
      sourcePath = puDetectSourcePath(contentZip);
      if (!sourcePath) return res.status(400).json({ error: 'Could not auto-detect source path from filter.xml.' });
      if (sourcePath === targetPath) targetPath = null;   // no-op move
    }

    if (!targetPath && assetReplacements.length === 0) {
      return res.status(400).json({ error: 'Nothing to do — provide a target path to move, or upload a bundle/asset-mapping.json for replacement.' });
    }

    const { outputZip, modifiedCount, log } = puProcessContentZip(contentZip, assetReplacements, sourcePath, targetPath);

    let outBuffer;
    if (bundle) {
      const finalBundle = new AdmZip();
      finalBundle.addFile('asset-mapping.json', mappingBuffer);
      finalBundle.addFile(innerZipName, outputZip.toBuffer());
      outBuffer = finalBundle.toBuffer();
    } else {
      outBuffer = outputZip.toBuffer();
    }

    puSessions.delete(sessionId);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="package_updated.zip"');
    res.setHeader('X-Modified-Count', String(modifiedCount));
    res.setHeader('X-Source-Path', sourcePath || '');
    res.setHeader('X-Pkg-Log', Buffer.from(JSON.stringify(log)).toString('base64'));
    res.send(outBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// LIGHTHOUSE / PAGESPEED INSIGHTS AUDIT
// ══════════════════════════════════════════════════════════════════════════════

const lhJobs = new Map();

function buildLhFlags(strategy, categories, throttlingMethod, port) {
  return {
    logLevel:        'silent',
    output:          'json',
    onlyCategories:  categories,
    port,
    formFactor:      strategy,
    throttlingMethod,
    ...(strategy === 'desktop' ? {
      screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
      ...(throttlingMethod === 'devtools' ? {
        throttling: { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1,
                      requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0 },
      } : {}),
    } : {}),
  };
}

function extractLhResult(url, lhr) {
  const cats = lhr.categories || {};
  const aud  = lhr.audits     || {};
  const score = key => {
    const s = cats[key]?.score;
    return s !== null && s !== undefined ? Math.round(s * 100) : null;
  };
  return {
    url, status: 'ok',
    scores: {
      performance:   score('performance'),
      seo:           score('seo'),
      accessibility: score('accessibility'),
      bestPractices: score('best-practices'),
    },
    metrics: {
      fcp: aud['first-contentful-paint']?.displayValue   || '–',
      lcp: aud['largest-contentful-paint']?.displayValue || '–',
      tbt: aud['total-blocking-time']?.displayValue      || '–',
      cls: aud['cumulative-layout-shift']?.displayValue  || '–',
      si:  aud['speed-index']?.displayValue              || '–',
    },
  };
}

// Each audit runs in its own child process (lighthouse-worker.js).
// Root cause for doing this: Node.js perf_hooks.performance is a global singleton.
// Concurrent Lighthouse calls in the same process call performance.clearMarks() and
// wipe each other's marks, producing "performance mark has not been set" for every
// page after the first. A separate process gets its own performance object.
const WORKER = path.join(__dirname, 'lighthouse-worker.js');
const AUDIT_TIMEOUT_MS = 120_000; // 2 minutes per page

function auditOne(url, chromeFlags, strategy, categories, throttlingMethod) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    let stdout = '';
    child.stdout.on('data', d => { stdout += d; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ url, status: 'error', error: `Audit timed out after ${AUDIT_TIMEOUT_MS / 1000}s` });
    }, AUDIT_TIMEOUT_MS);

    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ url, status: 'error', error: 'Worker returned invalid output' });
      }
    });

    child.on('error', err => {
      clearTimeout(timer);
      resolve({ url, status: 'error', error: err.message });
    });

    child.stdin.write(JSON.stringify({ url, chromeFlags, strategy, categories, throttlingMethod }));
    child.stdin.end();
  });
}

async function runAuditJob(job) {
  const { urls, strategy, categories, throttlingMethod = 'simulate', concurrency = 3, headless = false } = job;

  const chromeFlags = headless
    ? ['--headless=new', '--no-sandbox', '--disable-extensions', '--disable-gpu', '--disable-dev-shm-usage']
    : ['--no-sandbox', '--disable-extensions', '--window-size=1350,940', '--disable-dev-shm-usage'];

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency).map(u => u.trim()).filter(Boolean);
    await Promise.all(batch.map(async url => {
      const result = await auditOne(url, chromeFlags, strategy, categories, throttlingMethod);
      job.results.push(result);
      if (result.status === 'error') job.errors++;
      job.done++;
    }));
  }

  job.running = false;
}

app.post('/api/lighthouse/start', express.json({ limit: '200kb' }), (req, res) => {
  const {
    urls,
    strategy        = 'mobile',
    categories      = ['performance', 'seo', 'accessibility', 'best-practices'],
    throttlingMethod = 'devtools',
    concurrency     = 3,
    headless        = false,
  } = req.body;

  if (!Array.isArray(urls) || !urls.length) return res.status(400).json({ error: 'No URLs provided.' });

  const sessionId = randomUUID();
  const job = { urls, strategy, categories, throttlingMethod, concurrency, headless,
                results: [], done: 0, total: urls.length, running: true, errors: 0 };
  lhJobs.set(sessionId, job);
  setTimeout(() => lhJobs.delete(sessionId), 4 * 60 * 60 * 1000).unref?.();

  runAuditJob(job).catch(err => {
    job.running = false;
    job.fatalError = err.message;
  });

  res.json({ sessionId });
});

app.get('/api/lighthouse/progress/:sessionId', (req, res) => {
  const job = lhJobs.get(req.params.sessionId);
  if (!job) return res.status(404).json({ error: 'Session not found or expired.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`);
  send({ type: 'total', total: job.total });

  let lastDone = -1;
  const iv = setInterval(() => {
    if (job.done !== lastDone || !job.running) {
      lastDone = job.done;
      send({ type: 'progress', done: job.done, total: job.total, running: job.running, errors: job.errors, results: job.results });
    }
    if (!job.running) { clearInterval(iv); res.end(); }
  }, 600);

  req.on('close', () => clearInterval(iv));
});

// ══════════════════════════════════════════════════════════════════════════════
// PROPERTY UPDATER TOOL  (/api/prop-updater/*)
// Sets one property (on the matched node itself, or a fixed relative node
// pattern under it, e.g. jcr:content/root/hero) across every cq:Page — or,
// in asset mode, every dam:Asset — beneath a root path.
// ══════════════════════════════════════════════════════════════════════════════

let ppDiscovered = [];
let ppJob        = { running: false, total: 0, done: 0, errors: 0, log: [] };
let ppClients    = [];

function ppResolveEnvCfg(envName) {
  const env = loadSiteConfig().environments.find(e => e.name === envName);
  if (!env) return { error: `Environment "${envName || '(none selected)'}" not found in site.config.json.` };
  if (!appConfig.target?.username) {
    return { error: 'No target credentials configured. Set them up in Page Metadata → Configure.' };
  }
  return { cfg: { host: env.aemUrl, username: appConfig.target.username, password: appConfig.target.password } };
}

function ppQueryType(contentType) {
  return contentType === 'asset' ? 'dam:Asset' : 'cq:Page';
}

function ppNormalizePattern(nodePattern, contentType) {
  const trimmed = (nodePattern || '').replace(/^\/+|\/+$/g, '');
  if (trimmed) return trimmed;
  return contentType === 'asset' ? 'jcr:content/metadata' : 'jcr:content';
}

function ppBroadcast() {
  ppClients.forEach(c => sseWrite(c, ppJob));
}

app.get('/api/prop-updater/discover', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const { env, rootPath, nodePattern, propertyName, contentType } = req.query;
  const pattern = ppNormalizePattern(nodePattern, contentType);

  if (!rootPath) {
    sseWrite(res, { type: 'error', message: 'Root path is required.' });
    return res.end();
  }
  const resolved = ppResolveEnvCfg(env);
  if (resolved.error) {
    sseWrite(res, { type: 'error', message: resolved.error });
    return res.end();
  }

  try {
    const client = makeClient(resolved.cfg);
    sseWrite(res, { type: 'status', message: 'Fetching list from QueryBuilder...' });

    const qbRes = await client.get('/bin/querybuilder.json', {
      params: {
        path: rootPath,
        type: ppQueryType(contentType),
        'p.limit': -1,
        'p.hits': 'selective',
        'p.properties': 'jcr:path'
      }
    });

    const paths = (qbRes.data.hits || []).map(h => h['jcr:path']);
    sseWrite(res, { type: 'total', total: paths.length });

    ppDiscovered = [];
    let processed = 0;
    const CONCURRENCY = 10;

    async function checkOne(pagePath) {
      try {
        const r = await client.get(`${pagePath}/${pattern}.json`);
        const raw = propertyName ? r.data[propertyName] : undefined;
        const currentValue = raw === undefined ? null : normalizeValue(raw);
        return { path: pagePath, nodeExists: true, currentValue };
      } catch {
        return { path: pagePath, nodeExists: false, currentValue: null };
      }
    }

    for (let i = 0; i < paths.length; i += CONCURRENCY) {
      const batch = paths.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(checkOne));
      ppDiscovered.push(...results);
      processed += results.length;
      sseWrite(res, { type: 'progress', done: processed, total: paths.length });
    }

    sseWrite(res, {
      type: 'complete',
      total: ppDiscovered.length,
      nodeExistsCount: ppDiscovered.filter(p => p.nodeExists).length
    });
  } catch (err) {
    sseWrite(res, { type: 'error', message: err.message });
  }

  res.end();
});

app.get('/api/prop-updater/pages', (req, res) => {
  res.json({ pages: ppDiscovered });
});

app.get('/api/prop-updater/update/progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  ppClients.push(res);
  sseWrite(res, ppJob);
  req.on('close', () => {
    ppClients = ppClients.filter(c => c !== res);
  });
});

app.post('/api/prop-updater/update/start', async (req, res) => {
  const { selectedPaths, env, nodePattern, propertyName, propertyValue, valueType, contentType } = req.body;

  if (ppJob.running) return res.status(409).json({ error: 'Update already in progress' });
  if (!Array.isArray(selectedPaths) || !selectedPaths.length) return res.status(400).json({ error: 'No pages selected.' });
  if (!propertyName) return res.status(400).json({ error: 'Property name is required.' });
  if (propertyValue === undefined || propertyValue === '') return res.status(400).json({ error: 'Property value is required.' });

  const resolved = ppResolveEnvCfg(env);
  if (resolved.error) return res.status(400).json({ error: resolved.error });

  const pattern = ppNormalizePattern(nodePattern, contentType);
  ppJob = { running: true, total: selectedPaths.length, done: 0, errors: 0, log: [] };
  res.json({ ok: true, total: selectedPaths.length });
  ppBroadcast();

  const client = makeClient(resolved.cfg);
  const CONCURRENCY = 5;

  async function updateOnePage(pagePath) {
    try {
      const params = new URLSearchParams();
      appendConstant(params, propertyName, propertyValue, valueType);
      await client.post(`${pagePath}/${pattern}`, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      ppJob.log.push({ pagePath, status: 'success' });
    } catch (err) {
      ppJob.errors++;
      const errMsg = err.response?.data
        ? (typeof err.response.data === 'object' ? JSON.stringify(err.response.data) : err.response.data)
        : err.message;
      ppJob.log.push({ pagePath, status: 'error', message: errMsg });
    } finally {
      ppJob.done++;
      ppBroadcast();
    }
  }

  (async () => {
    for (let i = 0; i < selectedPaths.length; i += CONCURRENCY) {
      await Promise.all(selectedPaths.slice(i, i + CONCURRENCY).map(updateOnePage));
    }
    ppJob.running = false;
    ppBroadcast();
  })();
});

app.get('/api/prop-updater/export/log', (req, res) => {
  if (!ppJob.log.length) return res.status(400).json({ error: 'No update log available' });

  const headers = ['pagePath', 'status', 'message'];
  const rows = ppJob.log.map(entry =>
    headers.map(h => `"${String(entry[h] ?? '').replace(/"/g, '""')}"`).join(',')
  );
  const csv = [headers.join(','), ...rows].join('\r\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="property-update-log.csv"');
  res.send(csv);
});

// ══════════════════════════════════════════════════════════════════════════════
// SITE CREATOR TOOL  (/api/site-creator/*)
// ══════════════════════════════════════════════════════════════════════════════
require('./site-creator/routes')(app);

// ══════════════════════════════════════════════════════════════════════════════
// STATIC + LISTEN
// ══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AEM → EDS Migration Suite running at http://localhost:${PORT}`));
