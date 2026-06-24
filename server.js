const express        = require('express');
const { randomUUID } = require('crypto');
const axios          = require('axios');
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

function applyTransform(transform, val) {
  if (!transform) return val;
  if (transform === 'aem-tag-to-eds') {
    return Array.isArray(val)
      ? val.map(transformAemTagToEds)
      : transformAemTagToEds(String(val));
  }
  if (transform === 'dam-path-to-eds') {
    return Array.isArray(val) ? val.map(transformDamPath) : transformDamPath(val);
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
  const { pagePath } = req.body;
  const mapping = loadMapping();

  try {
    const sourceClient = makeClient(appConfig.source);
    const r = await sourceClient.get(`${pagePath}/jcr:content.1.json`);
    const pageProps = r.data;

    const targetPath = pagePath.replace(appConfig.source.rootPath, appConfig.target.rootPath);
    const params = {};

    for (const { aem, eds, transform } of mapping) {
      if (aem && eds && pageProps[aem] !== undefined) {
        const val = applyTransform(transform, pageProps[aem]);
        params[eds] = Array.isArray(val) ? val : String(val);
        if (Array.isArray(val)) params[`${eds}@TypeHint`] = 'String[]';
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
  const { selectedPaths } = req.body;

  if (updateJob.running) {
    return res.status(409).json({ error: 'Update already in progress' });
  }

  const mapping = loadMapping();
  if (!mapping.length) {
    return res.status(400).json({ error: 'mapping.json is empty. Add mappings before running update.' });
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

      for (const { aem, eds, transform } of mapping) {
        if (aem && eds && pageProps[aem] !== undefined) {
          const val = applyTransform(transform, pageProps[aem]);
          if (Array.isArray(val)) {
            val.forEach(v => params.append(eds, v));
            params.append(`${eds}@TypeHint`, 'String[]');
          } else {
            params.append(eds, String(val));
          }
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

// ── Site config ───────────────────────────────────────────────────────────────
app.get('/api/image/site-config', (req, res) => {
  res.json(loadSiteConfig());
});

// ── CSV status ────────────────────────────────────────────────────────────────
app.get('/api/image/csv-status', (req, res) => {
  const { environments = [] } = loadSiteConfig();
  const statuses = environments.map(env => {
    const cp = configPath(env.name);
    if (!fs.existsSync(csvPath(env.name)) || !fs.existsSync(cp)) {
      return { name: env.name, exists: false };
    }
    try {
      const config = JSON.parse(fs.readFileSync(cp, 'utf8'));
      return { name: env.name, exists: true, ...config };
    } catch {
      return { name: env.name, exists: false };
    }
  });
  res.json({ statuses });
});

// ── Build CSV ─────────────────────────────────────────────────────────────────
app.post('/api/image/build-csv', async (req, res) => {
  const { aemUrl, username, password, damRoot, dmHost, envName } = req.body;

  if (!aemUrl || !username || !password || !damRoot || !dmHost) {
    return res.json({ success: false, error: 'All fields are required.' });
  }

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
      const filename   = path.posix.basename(jcrPath);
      const openApiUrl = uuid && damStatus === 'approved'
        ? `https://${cleanHost}/adobe/assets/urn:aaid:aem:${uuid}/as/${filename}`
        : jcrPath;
      return { path: jcrPath, uuid, scene7Name, scene7File, damStatus, openApiUrl };
    });

    const statusCounts = rows.reduce((acc, r) => {
      acc[r.damStatus || '(empty)'] = (acc[r.damStatus || '(empty)'] || 0) + 1;
      return acc;
    }, {});
    log(`damStatus distribution: ${JSON.stringify(statusCounts)}`);
    const dmUrlCount = rows.filter(r => r.openApiUrl.startsWith('https://')).length;
    log(`DM Open API URLs generated: ${dmUrlCount} / ${rows.length}`);

    const csv = stringify(rows, {
      header: true,
      columns: [
        { key: 'path',        header: 'path'        },
        { key: 'uuid',        header: 'uuid'        },
        { key: 'scene7Name',  header: 'scene7Name'  },
        { key: 'scene7File',  header: 'scene7File'  },
        { key: 'damStatus',   header: 'damStatus'   },
        { key: 'openApiUrl',  header: 'openApiUrl'  },
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
      return `https://${targetDmHost}/adobe/assets/urn:aaid:aem:${row.uuid}/as/${filename}`;
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
      'p.properties':  'jcr:uuid jcr:content/metadata/dam:scene7Name jcr:content/metadata/dam:scene7File jcr:content/metadata/dam:status jcr:path',
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

  // Package-control / config content that must never be rewritten — copy through as-is.
  // Covers: the entire META-INF package-metadata tree (filter.xml, config.xml,
  // properties.xml, definition/.content.xml, …), a literal redirects.xml /
  // filter.xml file anywhere, and a `redirects` JCR node (whose config lives in
  // .../redirects/.content.xml).
  const SKIP_FILES = new Set(['redirects.xml', 'filter.xml']);
  const isSkipped = name => {
    const segs = name.split('/');
    if (segs.includes('META-INF')) return true;              // all package metadata
    if (SKIP_FILES.has(segs[segs.length - 1])) return true;  // redirects.xml / filter.xml
    if (segs.includes('redirects')) return true;             // any file inside a redirects node
    if (segs.includes('config')) return true;                // site config node (universal-editor-config, etc.)
    return false;
  };

  async function patchEntries(admZip) {
    const jsz = new JSZip();
    for (const e of admZip.getEntries()) {
      if (e.isDirectory) continue;
      if (e.entryName.endsWith('.xml') && !isSkipped(e.entryName)) {
        const before    = e.getData().toString('utf8');
        let after       = before;
        const file       = reportPath(e.entryName);
        const localeRoot = fixes.siteRoot ? getFileLocaleRoot(e.entryName, fixes.siteRoot) : '';

        // DAM config (shared by abbvie-abs in-place normalization and the standalone DAM fix)
        const damCfg = (fixes.damPaths?.correctRoot && fixes.damPaths?.oldRoots?.length)
          ? fixes.damPaths : null;

        // 1. Fix absolute base-site URLs first → output /content/..., immune to short-path fixer.
        //    Embedded /content/dam/... refs get their DAM prefix normalized in the same step.
        if (fixes.absBaseUrl?.baseDomain && localeRoot) {
          const r = fixAbsBaseUrl(after, fixes.absBaseUrl.baseDomain, localeRoot, damCfg);
          after = r.result;
          for (const c of r.changes) changes.push({ file, type: 'abbvie-abs', ...c });
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

// ── Fix all issues and return patched ZIP ─────────────────────────────────────
app.post('/api/link-checker/fix-issues', express.json({ limit: '2mb' }), async (req, res) => {
  const { sessionId, fixes } = req.body;
  const buffer = lcSessions.get(sessionId);
  if (!buffer) return res.status(404).json({ error: 'Session expired — re-upload the ZIP.' });

  try {
    if (fixes.scene7?.csvEnv) {
      const csvFile = path.join(DATA_DIR, `asset-map-${fixes.scene7.csvEnv}.csv`);
      if (!fs.existsSync(csvFile)) {
        return res.status(400).json({ error: `No CSV found for environment "${fixes.scene7.csvEnv}". Build it first in the Image/Asset tool.` });
      }
      const rows = parse(fs.readFileSync(csvFile, 'utf8'), { columns: true, skip_empty_lines: true });
      fixes.scene7.lookupMap = buildScene7LookupMap(rows);
    }

    // Resolve optional HEAD-validation config (env → AEM author host from site.config)
    let validateCfg = null;
    if (fixes.validate?.env) {
      const env = loadSiteConfig().environments.find(e => e.name === fixes.validate.env);
      if (!env) return res.status(400).json({ error: `Environment "${fixes.validate.env}" not found in site.config.json.` });
      validateCfg = { aemHost: env.aemUrl, username: fixes.validate.username, password: fixes.validate.password };
    }

    const { buf, fixedCount, unmatchedScene7, changes, unmatchedList } = await buildFixedZip(buffer, fixes);
    lcSessions.delete(sessionId);

    // Build a change-report CSV: every rewrite plus any unmatched Scene7 URL
    const reportRows = changes.map(c => ({
      file: c.file, type: c.type, status: 'changed', oldUrl: c.oldUrl, newUrl: c.newUrl,
    }));
    for (const u of unmatchedList) {
      reportRows.push({ file: u.file, type: 'scene7', status: 'unmatched (no CSV entry)', oldUrl: u.oldUrl, newUrl: '' });
    }

    // Optional: HEAD-check each rewritten URL against AEM and record the status.
    const headSummary = await headCheckReport(reportRows, validateCfg);

    const reportCsv = stringify(reportRows, {
      header: true,
      columns: [
        { key: 'file',       header: 'file'        },
        { key: 'type',       header: 'type'        },
        { key: 'status',     header: 'status'      },
        { key: 'oldUrl',     header: 'old_url'     },
        { key: 'newUrl',     header: 'new_url'     },
        { key: 'headStatus', header: 'head_status' },
      ],
    });
    const reportId = randomUUID();
    lcReports.set(reportId, reportCsv);
    setTimeout(() => lcReports.delete(reportId), 15 * 60 * 1000).unref?.();

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="fixed-package.zip"');
    res.setHeader('X-Fixed-Count',      String(fixedCount));
    res.setHeader('X-Unmatched-Scene7', String(unmatchedScene7));
    res.setHeader('X-Change-Count',     String(changes.length));
    res.setHeader('X-Head-Checked',     String(headSummary.checked));
    res.setHeader('X-Head-404',         String(headSummary.notFound));
    res.setHeader('X-Head-Errors',      String(headSummary.errors));
    res.setHeader('X-Report-Id',        reportId);
    res.send(buf);
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

// ── Export link report as CSV ─────────────────────────────────────────────────
app.post('/api/link-checker/export-csv', express.json({ limit: '50mb' }), (req, res) => {
  const { files } = req.body;
  if (!files?.length) return res.status(400).json({ error: 'No data to export.' });

  const rows = [];
  files.forEach(f => {
    f.links.forEach(l => rows.push({ file: f.file, url: l.url, type: l.type }));
  });

  const csv = stringify(rows, {
    header: true,
    columns: [
      { key: 'file', header: 'file' },
      { key: 'url',  header: 'url'  },
      { key: 'type', header: 'type' },
    ],
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="link-report.csv"');
  res.send(csv);
});

// ── Fix short paths (legacy route — kept for backward compatibility) ───────────
app.post('/api/link-checker/fix-short-paths', express.json({ limit: '1mb' }), async (req, res) => {
  const { sessionId, prefix } = req.body;
  if (!sessionId || !prefix) return res.status(400).json({ error: 'Missing sessionId or prefix.' });
  if (!prefix.startsWith('/'))  return res.status(400).json({ error: 'Prefix must start with /.' });

  const buffer = lcSessions.get(sessionId);
  if (!buffer) return res.status(404).json({ error: 'Session not found or expired — please re-upload the ZIP.' });

  try {
    const { buf, fixedCount } = await buildFixedZip(buffer, { siteRoot: prefix, shortPath: true });
    lcSessions.delete(sessionId);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="fixed-package.zip"');
    res.setHeader('X-Fixed-Count', String(fixedCount));
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
// STATIC + LISTEN
// ══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AEM → EDS Migration Suite running at http://localhost:${PORT}`));
