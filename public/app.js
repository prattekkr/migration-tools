// ══════════════════════════════════════════════════════════════════════════════
// SHARED UTILITIES
// ══════════════════════════════════════════════════════════════════════════════

function switchTool(name) {
  ['pkgupd', 'meta', 'image', 'linkchecker', 'pkg', 'info'].forEach(t => {
    document.getElementById(`tool-${t}`).style.display = name === t ? 'block' : 'none';
    document.getElementById(`tool-btn-${t}`).classList.toggle('active', name === t);
  });
}

function val(id) {
  return document.getElementById(id).value.trim();
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function show(id) { document.getElementById(id).style.display = 'block'; }
function hide(id) { document.getElementById(id).style.display = 'none'; }

// ══════════════════════════════════════════════════════════════════════════════
// PAGE METADATA TOOL
// ══════════════════════════════════════════════════════════════════════════════

// ─── State ────────────────────────────────────────────────────────────────────
let allPages      = [];
let allProps      = [];
let currentMapping = [];
let updateSSE     = null;
let appConfig     = {};

// ─── Tab navigation ───────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab-pane').forEach(p => p.style.display = 'none');
  document.querySelectorAll('.step-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`tab-${tab}`).style.display = 'block';
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
}

// ─── Config ───────────────────────────────────────────────────────────────────
async function loadConfig() {
  const cfg = await fetchJSON('/api/meta/config');
  document.getElementById('srcHost').value = cfg.source.host || '';
  document.getElementById('srcUser').value = cfg.source.username || '';
  document.getElementById('srcPass').value = cfg.source.password || '';
  document.getElementById('srcRoot').value = cfg.source.rootPath || '';
  document.getElementById('tgtHost').value = cfg.target.host || '';
  document.getElementById('tgtUser').value = cfg.target.username || '';
  document.getElementById('tgtPass').value = cfg.target.password || '';
  document.getElementById('tgtRoot').value = cfg.target.rootPath || '';
  return cfg;
}

async function saveConfig() {
  const cfg = {
    source: {
      host: val('srcHost'), username: val('srcUser'),
      password: val('srcPass'), rootPath: val('srcRoot')
    },
    target: {
      host: val('tgtHost'), username: val('tgtUser'),
      password: val('tgtPass'), rootPath: val('tgtRoot')
    }
  };

  const res = await fetchJSON('/api/meta/config', { method: 'POST', body: cfg });
  if (res.ok) {
    appConfig = cfg;
    showAlert('configAlert', 'success', 'Configuration saved. Proceed to Step 2 to discover pages.');
    setNavStatus('Config saved');
  }
}

async function testConnections() {
  showAlert('configAlert', 'info', 'Testing connections...');
  await saveConfig();
  try {
    const res = await fetch('/api/meta/discover', { method: 'GET' });
    if (res.ok) {
      showAlert('configAlert', 'success', 'Source AEM connection successful.');
    } else {
      showAlert('configAlert', 'danger', `Connection failed: HTTP ${res.status}`);
    }
  } catch (e) {
    showAlert('configAlert', 'danger', `Connection error: ${e.message}`);
  }
}

// ─── Discovery ────────────────────────────────────────────────────────────────
function startDiscover() {
  const btn = document.getElementById('discoverBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Discovering...';

  document.getElementById('discoverProgressWrap').style.display = 'block';
  document.getElementById('mappingSection').style.display = 'none';
  document.getElementById('exportCsvBtn').style.display = 'none';
  setProgress('discoverProgress', 'discoverProgressLabel', 0, 1, 'Connecting...');

  const es = new EventSource('/api/meta/discover');

  es.onmessage = (e) => {
    const data = JSON.parse(e.data);

    if (data.type === 'status') {
      document.getElementById('discoverProgressLabel').textContent = data.message;
    }
    if (data.type === 'total') {
      document.getElementById('discoverStats').textContent = `Found ${data.total} pages`;
    }
    if (data.type === 'progress') {
      setProgress('discoverProgress', 'discoverProgressLabel',
        data.done, data.total, `Processing ${data.done} / ${data.total} pages...`);
    }
    if (data.type === 'complete') {
      es.close();
      allProps = data.properties;
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-search me-2"></i>Re-discover';
      document.getElementById('discoverStats').textContent =
        `${data.total} pages · ${data.properties.length} unique properties`;
      document.getElementById('exportCsvBtn').style.display = '';
      setProgress('discoverProgress', 'discoverProgressLabel', 1, 1, 'Discovery complete.');
      loadDiscoveredPages().then(buildMappingTable);
    }
    if (data.type === 'error') {
      es.close();
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-search me-2"></i>Discover Pages & Properties';
      document.getElementById('discoverProgressLabel').textContent = `Error: ${data.message}`;
      document.getElementById('discoverProgress').classList.add('bg-danger');
    }
  };

  es.onerror = () => {
    es.close();
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-search me-2"></i>Discover Pages & Properties';
  };
}

async function loadDiscoveredPages() {
  const data = await fetchJSON('/api/meta/pages');
  allPages = data.pages;
  allProps = data.properties;
  buildPagesTable(allPages);
}

// ─── Mapping table ────────────────────────────────────────────────────────────
async function buildMappingTable() {
  const savedList = await fetchJSON('/api/meta/mapping');
  const savedMap  = {};
  savedList.forEach(m => { savedMap[m.aem] = m; });

  const samples = {};
  allProps.forEach(p => {
    for (const page of allPages) {
      if (page.properties[p]) { samples[p] = page.properties[p]; break; }
    }
  });

  const tbody = document.getElementById('mappingBody');
  tbody.innerHTML = '';

  allProps.forEach(prop => {
    const sample     = samples[prop] || '';
    const saved      = savedMap[prop];
    const edsVal     = saved?.eds || '';
    const transformVal = saved?.transform || '';
    tbody.insertAdjacentHTML('beforeend', mappingRow(prop, sample, edsVal, transformVal));
  });

  document.getElementById('mappingSection').style.display = 'block';
}

const TRANSFORMS = [
  { value: '',                label: 'None' },
  { value: 'aem-tag-to-eds', label: 'AEM Tag → EDS  (ns:path → corporate:ns/path)' },
  { value: 'dam-path-to-eds', label: 'DAM Path → EDS  (inserts /corporate/)' }
];

function transformOptions(selected = '') {
  return TRANSFORMS.map(t =>
    `<option value="${t.value}" ${t.value === selected ? 'selected' : ''}>${escHtml(t.label)}</option>`
  ).join('');
}

function mappingRow(aemProp, sample, edsVal = '', transformVal = '') {
  const sid = `eds_${aemProp.replace(/[^a-zA-Z0-9]/g, '_')}`;
  return `
    <tr data-aem="${escHtml(aemProp)}">
      <td><code class="text-primary">${escHtml(aemProp)}</code></td>
      <td class="text-muted small text-truncate" style="max-width:150px" title="${escHtml(sample)}">${escHtml(sample)}</td>
      <td>
        <input type="text" class="form-control form-control-sm eds-input" id="${sid}"
          placeholder="eds property name" value="${escHtml(edsVal)}" />
      </td>
      <td>
        <select class="form-select form-select-sm transform-input">
          ${transformOptions(transformVal)}
        </select>
      </td>
      <td>
        <button class="btn btn-sm btn-link text-danger p-0" onclick="this.closest('tr').remove()" title="Remove">
          <i class="bi bi-trash"></i>
        </button>
      </td>
    </tr>`;
}

function addCustomMapping() {
  document.getElementById('mappingBody').insertAdjacentHTML('beforeend', mappingRow('', '', ''));
}

function filterMappingTable() {
  const q = document.getElementById('propFilter').value.toLowerCase();
  document.querySelectorAll('#mappingBody tr').forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

async function saveMapping() {
  const rows   = document.querySelectorAll('#mappingBody tr');
  const mapping = [];

  rows.forEach(row => {
    const aem = row.getAttribute('data-aem') || row.querySelector('input[type=text]:first-of-type')?.value.trim();
    const eds = row.querySelector('.eds-input')?.value.trim();
    const transform = row.querySelector('.transform-input')?.value || '';
    if (aem && eds) {
      const entry = { aem, eds };
      if (transform) entry.transform = transform;
      mapping.push(entry);
    }
  });

  currentMapping = mapping;
  const res = await fetchJSON('/api/meta/mapping', { method: 'POST', body: mapping });
  if (res.ok) {
    showAlert('mappingAlert', 'success', `Mapping saved — ${mapping.length} properties mapped. Proceed to Step 3.`);
    setNavStatus(`${mapping.length} properties mapped`);
  }
}

// ─── Pages table ──────────────────────────────────────────────────────────────
function buildPagesTable(pages) {
  const tbody = document.getElementById('pagesBody');
  tbody.innerHTML = '';

  if (!pages.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-4">No pages found</td></tr>';
    return;
  }

  const srcRoot = appConfig.source?.rootPath || '';
  const tgtRoot = appConfig.target?.rootPath || '';

  pages.forEach(page => {
    const propCount  = Object.keys(page.properties).length;
    const targetPath = srcRoot && tgtRoot
      ? page.path.replace(srcRoot, tgtRoot)
      : '—';
    tbody.insertAdjacentHTML('beforeend', `
      <tr data-path="${escHtml(page.path)}" data-target="${escHtml(targetPath)}">
        <td><input type="checkbox" class="page-chk" onchange="updateSelectionCount()" /></td>
        <td class="small font-monospace">${escHtml(page.path)}</td>
        <td class="small font-monospace">${escHtml(targetPath)}</td>
        <td><span class="target-status text-muted">—</span></td>
        <td><span class="badge bg-secondary">${propCount}</span></td>
        <td><span class="status-cell text-muted">—</span></td>
      </tr>`);
  });

  updateSelectionCount();
}

function filterPagesTable() {
  const q = document.getElementById('pageFilter').value.toLowerCase();
  document.querySelectorAll('#pagesBody tr').forEach(row => {
    row.style.display = row.getAttribute('data-path')?.toLowerCase().includes(q) ? '' : 'none';
  });
}

function selectAll() {
  document.querySelectorAll('.page-chk').forEach(c => c.checked = true);
  document.getElementById('selectAllChk').checked = true;
  updateSelectionCount();
}

function deselectAll() {
  document.querySelectorAll('.page-chk').forEach(c => c.checked = false);
  document.getElementById('selectAllChk').checked = false;
  updateSelectionCount();
}

function toggleAll(chk) {
  document.querySelectorAll('.page-chk').forEach(c => c.checked = chk.checked);
  updateSelectionCount();
}

function updateSelectionCount() {
  const n = document.querySelectorAll('.page-chk:checked').length;
  document.getElementById('selectionCount').textContent = `${n} page${n !== 1 ? 's' : ''} selected`;
}

function getSelectedPaths() {
  return [...document.querySelectorAll('#pagesBody tr')]
    .filter(r => r.querySelector('.page-chk')?.checked)
    .map(r => r.getAttribute('data-path'));
}

// ─── Client-side transforms ───────────────────────────────────────────────────
function clientTransform(transform, val) {
  if (!transform) return val;
  const applyOne = (v) => {
    if (transform === 'aem-tag-to-eds') {
      const idx = v.indexOf(':');
      if (idx === -1) return v;
      return `corporate:${v.slice(0, idx)}/${v.slice(idx + 1)}`;
    }
    if (transform === 'dam-path-to-eds') {
      return String(v).replace('/content/dam/', '/content/dam/corporate/');
    }
    return v;
  };
  return Array.isArray(val) ? val.map(applyOne) : applyOne(String(val));
}

// ─── Preview ──────────────────────────────────────────────────────────────────
async function previewUpdate() {
  const selected = getSelectedPaths();
  if (!selected.length) return alert('Select at least one page.');

  const mapping = await fetchJSON('/api/meta/mapping');
  if (!mapping.length) return alert('No mapping defined. Go to Step 2 and save a mapping.');

  const tbody = document.getElementById('previewModalBody');
  tbody.innerHTML = '';
  let rowCount = 0;

  const selectedPages = allPages.filter(p => selected.includes(p.path));

  selectedPages.forEach(page => {
    mapping.forEach(({ aem, eds, transform }) => {
      if (page.properties[aem] !== undefined) {
        rowCount++;
        const sourceVal    = page.properties[aem];
        const targetVal    = clientTransform(transform, sourceVal);
        const sourceDisplay = Array.isArray(sourceVal) ? sourceVal.join(' | ') : String(sourceVal);
        const targetDisplay = Array.isArray(targetVal) ? targetVal.join(' | ') : String(targetVal);
        const changed = sourceDisplay !== targetDisplay;

        tbody.insertAdjacentHTML('beforeend', `
          <tr>
            <td class="small font-monospace">${escHtml(page.path)}</td>
            <td><code class="text-primary">${escHtml(aem)}</code></td>
            <td class="text-muted small">${escHtml(sourceDisplay)}</td>
            <td><code class="text-success">${escHtml(eds)}</code></td>
            <td class="small ${changed ? 'text-warning fw-semibold' : 'text-muted'}">${escHtml(targetDisplay)}</td>
          </tr>`);
      }
    });
  });

  if (!rowCount) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-3">No matching properties found for selected pages.</td></tr>';
  }

  new bootstrap.Modal(document.getElementById('previewModal')).show();
}

// ─── Run Update ───────────────────────────────────────────────────────────────
async function runUpdate() {
  const selected = getSelectedPaths();
  if (!selected.length) return alert('Select at least one page.');

  const mapping = await fetchJSON('/api/meta/mapping');
  if (!mapping.length) return alert('No mapping defined. Go to Step 2 and save a mapping.');

  document.getElementById('updateProgressSection').style.display = 'block';
  document.getElementById('runBtn').disabled     = true;
  document.getElementById('previewBtn').disabled = true;
  document.getElementById('updateLog').innerHTML = '';
  resetStats();

  if (updateSSE) updateSSE.close();
  updateSSE = new EventSource('/api/meta/update/progress');
  updateSSE.onmessage = (e) => {
    const job = JSON.parse(e.data);
    renderUpdateProgress(job);
    if (!job.running) {
      updateSSE.close();
      document.getElementById('runBtn').disabled     = false;
      document.getElementById('previewBtn').disabled = false;
    }
  };

  await fetchJSON('/api/meta/update/start', {
    method: 'POST',
    body: { selectedPaths: selected }
  });
}

function renderUpdateProgress(job) {
  document.getElementById('metaStatTotal').textContent   = job.total;
  document.getElementById('metaStatDone').textContent    = job.done - job.errors - job.skipped;
  document.getElementById('metaStatErrors').textContent  = job.errors;
  document.getElementById('metaStatSkipped').textContent = job.skipped;

  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  const bar  = document.getElementById('updateProgressBar');
  bar.style.width = pct + '%';
  bar.className = 'progress-bar' + (job.running ? ' progress-bar-striped progress-bar-animated' : '') +
    (job.errors > 0 && !job.running ? ' bg-warning' : '');
  document.getElementById('updateProgressLabel').textContent =
    job.running ? `Processing ${job.done} of ${job.total}...` : `Complete — ${job.total} pages processed`;

  const tbody = document.getElementById('updateLog');
  const existingCount = tbody.querySelectorAll('tr').length;
  const newEntries    = job.log.slice(existingCount);

  newEntries.forEach(entry => {
    const badgeClass = entry.status === 'success' ? 'bg-success' :
      entry.status === 'error' ? 'bg-danger' : 'bg-secondary';
    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td class="small font-monospace">${escHtml(entry.path)}</td>
        <td><span class="badge ${badgeClass}">${entry.status}</span></td>
        <td class="small text-muted">${escHtml(entry.message || '')}</td>
      </tr>`);
  });

  job.log.forEach(entry => {
    const row = document.querySelector(`#pagesBody tr[data-path="${CSS.escape(entry.pagePath)}"]`);
    if (row) {
      const cell = row.querySelector('.status-cell');
      const cls  = entry.status === 'success' ? 'text-success' :
        entry.status === 'error' ? 'text-danger' : 'text-warning';
      cell.className = `status-cell ${cls}`;
      cell.innerHTML = entry.status === 'success'
        ? '<i class="bi bi-check-circle-fill"></i>'
        : entry.status === 'error'
          ? '<i class="bi bi-x-circle-fill"></i>'
          : '<i class="bi bi-dash-circle"></i>';
    }
  });
}

function resetStats() {
  ['metaStatTotal','metaStatDone','metaStatErrors','metaStatSkipped']
    .forEach(id => document.getElementById(id).textContent = '0');
  document.getElementById('updateProgressBar').style.width = '0%';
  document.getElementById('updateProgressLabel').textContent = '';
}

// ─── Verify targets ───────────────────────────────────────────────────────────
async function verifyTargets() {
  const btn  = document.getElementById('verifyBtn');
  const rows = [...document.querySelectorAll('#pagesBody tr[data-target]')];
  if (!rows.length) return alert('No pages loaded. Run discovery first.');

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Verifying...';

  const targets = rows.map(r => ({
    sourcePath: r.getAttribute('data-path'),
    targetPath: r.getAttribute('data-target')
  }));

  const results = await fetchJSON('/api/meta/verify-targets', { method: 'POST', body: { targets } });

  results.forEach(({ sourcePath, exists }) => {
    const row = document.querySelector(`#pagesBody tr[data-path="${CSS.escape(sourcePath)}"]`);
    if (!row) return;
    const cell = row.querySelector('.target-status');
    if (exists) {
      cell.className = 'target-status text-success';
      cell.innerHTML = '<i class="bi bi-check-circle-fill" title="Target exists"></i>';
    } else {
      cell.className = 'target-status text-danger';
      cell.innerHTML = '<i class="bi bi-x-circle-fill" title="Target page not found"></i> <small>Not found</small>';
      row.classList.add('table-warning');
    }
  });

  btn.disabled = false;
  btn.innerHTML = '<i class="bi bi-shield-check me-1"></i>Verify Targets';
}

// ─── Exports ──────────────────────────────────────────────────────────────────
function exportCsv() { window.location.href = '/api/meta/export/csv'; }
function exportLog()  { window.location.href = '/api/meta/export/log'; }

// ─── Meta utilities ───────────────────────────────────────────────────────────
function showAlert(containerId, type, msg) {
  document.getElementById(containerId).innerHTML =
    `<div class="alert alert-${type} alert-dismissible py-2 mb-0">
      ${msg}
      <button type="button" class="btn-close btn-sm" data-bs-dismiss="alert"></button>
    </div>`;
}

function setNavStatus(msg) {
  document.getElementById('navStatus').textContent = msg;
}

function setProgress(barId, labelId, done, total, label) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  document.getElementById(barId).style.width = pct + '%';
  document.getElementById(labelId).textContent = label;
}

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, {
    method:  opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body:    opts.body ? JSON.stringify(opts.body) : undefined
  });
  return res.json();
}

// ─── Meta init ────────────────────────────────────────────────────────────────
async function metaInit() {
  const cfg = await loadConfig();
  appConfig = cfg;
}

// ══════════════════════════════════════════════════════════════════════════════
// IMAGE / ASSET TOOL
// ══════════════════════════════════════════════════════════════════════════════

// ─── State ────────────────────────────────────────────────────────────────────
let outputFilename     = null;
let reportFilename     = null;
let swapOutputFilename = null;
let swapReportFilename = null;
let environments       = [];

// ─── Environments ─────────────────────────────────────────────────────────────
async function loadEnvironments() {
  try {
    const data = await get('/api/image/site-config');
    environments = data.environments || [];
    if (environments.length === 0) return;

    const select       = document.getElementById('envSelect');
    const targetSelect = document.getElementById('targetEnvSelect');
    const swapSelect   = document.getElementById('swapTargetEnv');

    select.innerHTML       = '<option value="">— Select environment —</option>';
    targetSelect.innerHTML = '<option value="">— Select target environment —</option>';
    swapSelect.innerHTML   = '<option value="">— Select target environment —</option>';

    environments.forEach((env, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = env.name;
      select.appendChild(opt);

      const tOpt = document.createElement('option');
      tOpt.value = env.name;
      tOpt.textContent = env.name;
      targetSelect.appendChild(tOpt);

      const sOpt = document.createElement('option');
      sOpt.value = env.name;
      sOpt.textContent = env.name;
      swapSelect.appendChild(sOpt);
    });

    show('envSelectorWrap');
  } catch { /* no site config */ }
}

function getProcessingMode() {
  return document.querySelector('input[name="processingMode"]:checked')?.value || 'shared';
}

function onModeChange() {
  const mode  = getProcessingMode();
  const label = document.getElementById('targetEnvLabel');
  label.textContent = mode === 'shared'
    ? 'Target Environment (delivery domain will be swapped)'
    : 'Target Environment (per-environment CSV will be loaded)';
  loadCsvStatus();
}

function onEnvChange() {
  const idx = document.getElementById('envSelect').value;
  if (idx === '') return;
  const env = environments[parseInt(idx)];
  if (!env) return;
  if (env.aemUrl)  document.getElementById('aemUrl').value  = env.aemUrl;
  if (env.damRoot) document.getElementById('damRoot').value = env.damRoot;
  if (env.dmHost)  document.getElementById('dmHost').value  = env.dmHost;
  loadCsvStatus();
}

// ─── Use AEM from meta config ─────────────────────────────────────────────────
async function fillFromMetaConfig() {
  try {
    const cfg = await get('/api/meta/config');
    if (cfg?.source?.host)     document.getElementById('aemUrl').value   = cfg.source.host;
    if (cfg?.source?.username) document.getElementById('username').value = cfg.source.username;
    if (cfg?.source?.password) document.getElementById('password').value = cfg.source.password;
  } catch {
    alert('Could not load Page Metadata config. Save it in the Page Metadata tab first.');
  }
}

// ─── CSV Status ───────────────────────────────────────────────────────────────
async function loadCsvStatus() {
  try {
    const data = await get('/api/image/csv-status');
    applyCsvStatus(data);
  } catch {
    setPill('none', 'Could not reach server.');
  }
}

function applyCsvStatus(data) {
  const statuses     = data.statuses || [];
  const mode         = getProcessingMode();
  const targetSelect = document.getElementById('targetEnvSelect');

  [...targetSelect.options].forEach(opt => {
    if (!opt.value) return;
    const env = environments.find(e => e.name === opt.value);
    const s   = statuses.find(s => s.name === opt.value);
    if (mode === 'shared') {
      const host = (env?.dmHost || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
      opt.textContent = `${opt.value} — ${host}`;
    } else {
      if (s?.exists) {
        const date = new Date(s.lastBuilt).toLocaleString();
        opt.textContent = `${opt.value} ✓ (${s.count.toLocaleString()} assets, ${date})`;
      } else {
        opt.textContent = `${opt.value} ✗ (no CSV — build first)`;
      }
    }
  });

  const envIdx         = document.getElementById('envSelect').value;
  const selectedEnvName = envIdx !== '' ? environments[parseInt(envIdx)]?.name : null;
  const relevant = selectedEnvName
    ? statuses.find(s => s.name === selectedEnvName)
    : statuses.find(s => s.exists);

  if (relevant?.exists) {
    const date = new Date(relevant.lastBuilt).toLocaleString();
    setPill('ok', `${relevant.name}: ${relevant.count.toLocaleString()} assets indexed — last built ${date}`);
    show('refreshBtn'); hide('buildBtn');
  } else {
    setPill('none', selectedEnvName
      ? `No CSV for "${selectedEnvName}" — fill in the form and click Build CSV`
      : 'No CSV found — select an environment and click Build CSV');
    show('buildBtn'); hide('refreshBtn');
  }
}

function setPill(state, text) {
  document.getElementById('csvPill').className    = `csv-pill ${state === 'ok' ? 'ok' : state === 'none' ? 'none' : 'loading'}`;
  document.getElementById('csvDot').className     = `dot ${state === 'ok' ? 'dot-green' : state === 'none' ? 'dot-orange' : 'dot-gray'}`;
  document.getElementById('csvPillText').textContent = text;
}

// ─── Build CSV ────────────────────────────────────────────────────────────────
async function buildCsv() {
  const envIdx      = document.getElementById('envSelect').value;
  const selectedEnv = envIdx !== '' ? environments[parseInt(envIdx)] : null;
  const body = {
    aemUrl:   val('aemUrl'),
    username: val('username'),
    password: val('password'),
    damRoot:  val('damRoot'),
    dmHost:   val('dmHost'),
    envName:  selectedEnv ? selectedEnv.name : 'default',
  };
  if (!body.aemUrl || !body.username || !body.password || !body.damRoot || !body.dmHost) {
    showBanner('csvBanner', 'error', 'Please fill in all fields.');
    return;
  }

  setDisabled(['buildBtn', 'refreshBtn'], true);
  hideBanner('csvBanner');
  clearLog('csvLog');
  setPill('loading', 'Querying AEM assets…');

  try {
    const response = await fetch('/api/image/build-csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.log) appendLog('csvLog', msg.log);
          if (msg.done) {
            if (msg.success) {
              showBanner('csvBanner', 'success', `✓ CSV built — ${msg.count.toLocaleString()} assets indexed.`);
              await loadCsvStatus();
            } else {
              showBanner('csvBanner', 'error', `Error: ${msg.error}`);
              setPill('none', 'Build failed');
            }
          }
        } catch { /* incomplete JSON line */ }
      }
    }
  } catch (err) {
    showBanner('csvBanner', 'error', `Request failed: ${err.message}`);
    setPill('none', 'Build failed');
  } finally {
    setDisabled(['buildBtn', 'refreshBtn'], false);
  }
}

// ─── File Upload ──────────────────────────────────────────────────────────────
function onFileSelected(input) {
  const file = input.files[0];
  if (!file) return;

  const zone = document.getElementById('uploadZone');
  zone.classList.add('has-file');
  document.getElementById('uploadIcon').textContent  = '✅';
  document.getElementById('uploadTitle').textContent = file.name;
  document.getElementById('uploadSub').textContent   = `${(file.size / 1024).toFixed(1)} KB — click to change`;

  showBanner('fileReadyBanner', 'success', `✓ "${file.name}" ready (${(file.size / 1024).toFixed(1)} KB) — click Process ZIP to start.`);
  show('processCard');
  clearLog('zipLog');
  hideBanner('zipBanner');
  hide('resultsWrap');
  hide('downloadRow');
}

function changeZip() {
  document.getElementById('zipInput').value = '';
  document.getElementById('uploadZone').classList.remove('has-file');
  document.getElementById('uploadIcon').textContent  = '📦';
  document.getElementById('uploadTitle').textContent = 'Click to browse for ZIP file';
  document.getElementById('uploadSub').textContent   = 'Select the AEM package ZIP (e.g. test.zip)';
  hideBanner('fileReadyBanner');
  hide('processCard');
}

// ─── Root Path Remappings ─────────────────────────────────────────────────────
function addRootRow(oldRoot = '', newRoot = '') {
  const container = document.getElementById('rootRows');
  const row = document.createElement('div');
  row.className = 'mapping-row';
  row.innerHTML = `
    <input type="text" placeholder="/content/dam/abbv" value="${escHtml(oldRoot)}"
      class="path-input ${oldRoot ? 'has-value' : ''}"
      oninput="this.classList.toggle('has-value', this.value.length > 0)" />
    <input type="text" placeholder="/content/dam/corporate" value="${escHtml(newRoot)}"
      class="url-input ${newRoot ? 'has-value' : ''}"
      oninput="this.classList.toggle('has-value', this.value.length > 0)" />
    <button class="del-btn" onclick="removeRootRow(this)" title="Remove">✕</button>
  `;
  container.appendChild(row);
  show('rootTable');
  hide('noRoots');
}

function removeRootRow(btn) {
  btn.closest('.mapping-row').remove();
  const hasRows = document.getElementById('rootRows').children.length > 0;
  if (!hasRows) { hide('rootTable'); show('noRoots'); }
}

function getRootMappings() {
  return [...document.querySelectorAll('#rootRows .mapping-row')]
    .map(row => ({
      oldRoot: row.querySelector('.path-input').value.trim(),
      newRoot: row.querySelector('.url-input').value.trim(),
    }))
    .filter(m => m.oldRoot && m.newRoot);
}

// ─── Custom Mappings (image tool) ─────────────────────────────────────────────
function addMappingRow(path = '', url = '') {
  const container = document.getElementById('imgMappingRows');
  const row = document.createElement('div');
  row.className = 'mapping-row';
  row.innerHTML = `
    <input type="text" placeholder="/content/dam/abbv/..." value="${escHtml(path)}"
      class="path-input ${path ? 'has-value' : ''}"
      oninput="this.classList.toggle('has-value', this.value.length > 0)" />
    <input type="text" placeholder="https://delivery-... or /content/dam/..." value="${escHtml(url)}"
      class="url-input ${url ? 'has-value' : ''}"
      oninput="this.classList.toggle('has-value', this.value.length > 0)" />
    <button class="del-btn" onclick="removeMappingRow(this)" title="Remove">✕</button>
  `;
  container.appendChild(row);
  show('imgMappingTable');
  hide('imgNoMappings');
}

function removeMappingRow(btn) {
  btn.closest('.mapping-row').remove();
  const hasRows = document.getElementById('imgMappingRows').children.length > 0;
  if (!hasRows) { hide('imgMappingTable'); show('imgNoMappings'); }
}

function getCustomMappings() {
  return [...document.querySelectorAll('#imgMappingRows .mapping-row')]
    .map(row => ({
      path: row.querySelector('.path-input').value.trim(),
      url:  row.querySelector('.url-input').value.trim(),
    }))
    .filter(m => m.path && m.url);
}

function populateUnmatched(unmatchedPaths) {
  if (!unmatchedPaths?.length) return;
  unmatchedPaths.forEach(p => addMappingRow(p, ''));
  document.getElementById('imgMappingRows').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─── Process ZIP ──────────────────────────────────────────────────────────────
function processZip() {
  const fileInput = document.getElementById('zipInput');
  if (!fileInput.files[0]) { alert('No file selected.'); return; }

  const formData = new FormData();
  formData.append('zip', fileInput.files[0]);
  formData.append('customMappings', JSON.stringify(getCustomMappings()));
  formData.append('rootMappings',   JSON.stringify(getRootMappings()));
  const targetEnvVal = document.getElementById('targetEnvSelect').value;
  if (targetEnvVal) formData.append('targetEnv', targetEnvVal);
  formData.append('processingMode', getProcessingMode());

  setDisabled(['processBtn', 'changeZipBtn'], true);
  hideBanner('zipBanner');
  clearLog('zipLog');
  hide('resultsWrap');
  hide('downloadRow');
  appendLog('zipLog', `Sending ${fileInput.files[0].name}...`);

  const xhr = new XMLHttpRequest();
  xhr.timeout = 300000;

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      appendLog('zipLog', `Uploading... ${Math.round(e.loaded / e.total * 100)}%`);
    }
  };

  xhr.onload = () => {
    setDisabled(['processBtn', 'changeZipBtn'], false);
    try {
      const data = JSON.parse(xhr.responseText);
      printLogs('zipLog', data.logs || []);
      if (data.success) {
        outputFilename = data.outputFile;
        reportFilename = data.reportFile;
        renderResults(data);
        show('resultsWrap');
        show('downloadRow');
        showBanner('zipBanner', 'success', '✓ ZIP processed successfully.');
        if (data.unmatchedPaths?.length) populateUnmatched(data.unmatchedPaths);
      } else {
        showBanner('zipBanner', 'error', `Error: ${data.error}`);
      }
    } catch {
      showBanner('zipBanner', 'error', `Bad response: ${xhr.responseText.substring(0, 200)}`);
    }
  };

  xhr.onerror   = () => { setDisabled(['processBtn', 'changeZipBtn'], false); showBanner('zipBanner', 'error', 'Network error.'); };
  xhr.ontimeout = () => { setDisabled(['processBtn', 'changeZipBtn'], false); showBanner('zipBanner', 'error', 'Timed out after 5 min.'); };

  xhr.open('POST', '/api/image/update-zip');
  xhr.send(formData);
}

// ─── Results ──────────────────────────────────────────────────────────────────
function renderResults(data) {
  const { total, replaced, unmatched, filesProcessed } = data.stats;
  document.getElementById('statTotal').textContent     = total.toLocaleString();
  document.getElementById('statReplaced').textContent  = replaced.toLocaleString();
  document.getElementById('statUnmatched').textContent = unmatched.toLocaleString();
  document.getElementById('statFiles').textContent     = filesProcessed.toLocaleString();
  document.getElementById('statUnmatched').closest('.stat-card').className = `stat-card ${unmatched > 0 ? 'warn' : 'good'}`;

  const unmatchedBox = document.getElementById('unmatchedBox');
  if (unmatched > 0 && data.unmatchedPaths?.length) {
    document.getElementById('unmatchedList').textContent = data.unmatchedPaths.join('\n');
    unmatchedBox.style.display = 'block';
  } else {
    unmatchedBox.style.display = 'none';
  }
}

// ─── Download ─────────────────────────────────────────────────────────────────
function downloadZip()        { if (outputFilename)     window.location.href = `/api/image/download/${outputFilename}`; }
function downloadReport()     { if (reportFilename)     window.location.href = `/api/image/download/${reportFilename}`; }
function downloadSwapZip()    { if (swapOutputFilename) window.location.href = `/api/image/download/${swapOutputFilename}`; }
function downloadSwapReport() { if (swapReportFilename) window.location.href = `/api/image/download/${swapReportFilename}`; }

// ─── Domain Swap (Step 4) ─────────────────────────────────────────────────────
function onSwapFileSelected(input) {
  const file = input.files[0];
  if (!file) return;
  document.getElementById('swapUploadZone').classList.add('has-file');
  document.getElementById('swapUploadIcon').textContent  = '✅';
  document.getElementById('swapUploadTitle').textContent = file.name;
  document.getElementById('swapUploadSub').textContent   = `${(file.size / 1024).toFixed(1)} KB — click to change`;
  showBanner('swapFileBanner', 'success', `✓ "${file.name}" ready — select target environment and click Swap Domain.`);
  clearLog('swapLog');
  hideBanner('swapBanner');
  hide('swapResultsWrap');
  hide('swapDownloadRow');
}

function changeSwapZip() {
  document.getElementById('swapZipInput').value = '';
  document.getElementById('swapUploadZone').classList.remove('has-file');
  document.getElementById('swapUploadIcon').textContent  = '📦';
  document.getElementById('swapUploadTitle').textContent = 'Click to browse for already-processed ZIP';
  document.getElementById('swapUploadSub').textContent   = 'The ZIP should already contain DM Open API URLs';
  hideBanner('swapFileBanner');
  clearLog('swapLog');
  hideBanner('swapBanner');
  hide('swapResultsWrap');
  hide('swapDownloadRow');
}

function swapDomainZip() {
  const fileInput = document.getElementById('swapZipInput');
  if (!fileInput.files[0]) { alert('No file selected.'); return; }

  const targetEnv = document.getElementById('swapTargetEnv').value;
  if (!targetEnv) { alert('Please select a target environment.'); return; }

  const formData = new FormData();
  formData.append('zip', fileInput.files[0]);
  formData.append('targetEnv', targetEnv);

  setDisabled(['swapBtn', 'swapChangeBtn'], true);
  hideBanner('swapBanner');
  clearLog('swapLog');
  hide('swapResultsWrap');
  hide('swapDownloadRow');
  appendLog('swapLog', `Sending ${fileInput.files[0].name}...`);

  const xhr = new XMLHttpRequest();
  xhr.timeout = 300000;

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) appendLog('swapLog', `Uploading... ${Math.round(e.loaded / e.total * 100)}%`);
  };

  xhr.onload = () => {
    setDisabled(['swapBtn', 'swapChangeBtn'], false);
    try {
      const data = JSON.parse(xhr.responseText);
      printLogs('swapLog', data.logs || []);
      if (data.success) {
        swapOutputFilename = data.outputFile;
        swapReportFilename = data.reportFile;
        const { total, replaced, filesProcessed } = data.stats;
        document.getElementById('swapStatTotal').textContent    = total.toLocaleString();
        document.getElementById('swapStatReplaced').textContent = replaced.toLocaleString();
        document.getElementById('swapStatFiles').textContent    = filesProcessed.toLocaleString();
        show('swapResultsWrap');
        show('swapDownloadRow');
        showBanner('swapBanner', 'success', `✓ Domain swapped to "${targetEnv}" — ${replaced} URL(s) updated across ${filesProcessed} file(s).`);
      } else {
        showBanner('swapBanner', 'error', `Error: ${data.error}`);
      }
    } catch {
      showBanner('swapBanner', 'error', `Bad response: ${xhr.responseText.substring(0, 200)}`);
    }
  };

  xhr.onerror   = () => { setDisabled(['swapBtn', 'swapChangeBtn'], false); showBanner('swapBanner', 'error', 'Network error.'); };
  xhr.ontimeout = () => { setDisabled(['swapBtn', 'swapChangeBtn'], false); showBanner('swapBanner', 'error', 'Timed out after 5 min.'); };

  xhr.open('POST', '/api/image/swap-domain');
  xhr.send(formData);
}

// ─── Image utilities ──────────────────────────────────────────────────────────
function printLogs(id, logs) { logs.forEach(msg => appendLog(id, msg)); }

function appendLog(id, message) {
  const box = document.getElementById(id);
  box.classList.add('visible');
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = `› ${message}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function clearLog(id) {
  const el = document.getElementById(id);
  el.innerHTML = '';
  el.classList.remove('visible');
}

function showBanner(id, type, message) {
  const el = document.getElementById(id);
  el.className = `img-banner visible ${type}`;
  el.textContent = message;
}

function hideBanner(id) { document.getElementById(id).className = 'img-banner'; }

function setDisabled(ids, state) {
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = state; });
}

async function get(url)  { return (await fetch(url)).json(); }
async function post(url, body) {
  return (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
}

// ─── Image init ───────────────────────────────────────────────────────────────
async function imageInit() {
  await loadEnvironments();
  await loadCsvStatus();
}

// ══════════════════════════════════════════════════════════════════════════════
// LINK CHECKER TOOL
// ══════════════════════════════════════════════════════════════════════════════

// ─── State ────────────────────────────────────────────────────────────────────
let lcData              = null;   // { stats, files } from last check
let lcTypeFilter        = 'all';  // active type filter
let lcFile              = null;   // selected File object
let lcSiteRoots         = [];     // configured site roots (persisted in localStorage)
let lcSiteRootsExpanded = true;   // collapsed state for site root config card

const LC_ROOTS_KEY = 'lc-site-roots';

const LC_TYPE_LABELS = {
  dam:            { label: 'DAM',          cls: 'lc-badge-dam'       },
  internal:       { label: 'Internal',     cls: 'lc-badge-internal'  },
  external:       { label: 'External',     cls: 'lc-badge-external'  },
  'scene7':       { label: 'Scene7',         cls: 'lc-badge-scene7'     },
  'dm-openapi':   { label: 'DM Open API',   cls: 'lc-badge-dmopenapi'  },
  'aem-cloud':    { label: 'AEM Cloud',     cls: 'lc-badge-aemcloud'   },
  'abbvie-abs':   { label: 'AbbVie (Abs)',  cls: 'lc-badge-abbvieabs'  },
  'short-path':   { label: 'Short Path',   cls: 'lc-badge-shortpath'  },
  other:          { label: 'Other',        cls: 'lc-badge-other'     },
};

// ─── Site root configuration ──────────────────────────────────────────────────
function lcLoadSiteRoots() {
  try { lcSiteRoots = JSON.parse(localStorage.getItem(LC_ROOTS_KEY) || '[]'); } catch { lcSiteRoots = []; }
  lcRenderSiteRoots();
}

function lcSaveSiteRoots() {
  localStorage.setItem(LC_ROOTS_KEY, JSON.stringify(lcSiteRoots));
}

function lcRenderSiteRoots() {
  const list = document.getElementById('lcSiteRootList');
  if (!lcSiteRoots.length) {
    list.innerHTML = '<p class="text-muted small mb-0">No site roots configured.</p>';
    return;
  }
  list.innerHTML = lcSiteRoots.map((root, i) => `
    <div class="d-flex align-items-center gap-2 mb-1">
      <code class="small">${escHtml(root)}</code>
      <button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="lcRemoveSiteRoot(${i})" title="Remove">
        <i class="bi bi-x"></i>
      </button>
    </div>`).join('');
}

function lcAddSiteRoot() {
  const input = document.getElementById('lcSiteRootInput');
  const root  = input.value.trim();
  if (!root) return;
  if (!root.startsWith('/')) { alert('Site root must start with /'); return; }
  if (lcSiteRoots.includes(root)) { input.value = ''; return; }
  lcSiteRoots.push(root);
  lcSaveSiteRoots();
  lcRenderSiteRoots();
  input.value = '';
}

function lcRemoveSiteRoot(i) {
  lcSiteRoots.splice(i, 1);
  lcSaveSiteRoots();
  lcRenderSiteRoots();
}

function lcToggleSiteRoots() {
  lcSiteRootsExpanded = !lcSiteRootsExpanded;
  document.getElementById('lcSiteRootBody').style.display    = lcSiteRootsExpanded ? 'block' : 'none';
  document.getElementById('lcSiteRootChevron').style.transform = lcSiteRootsExpanded ? '' : 'rotate(180deg)';
}

// ─── File selection ───────────────────────────────────────────────────────────
function lcOnFileSelected(input) {
  const file = input.files[0];
  if (!file) return;
  lcFile = file;

  document.getElementById('lcUploadZone').classList.add('lc-has-file');
  document.getElementById('lcUploadTitle').textContent = file.name;
  document.getElementById('lcUploadSub').textContent   = `${(file.size / 1024 / 1024).toFixed(2)} MB — click to change`;
  document.getElementById('lcCheckBtn').disabled = false;
  document.getElementById('lcStatus').textContent = '';
}

function lcReset() {
  lcFile       = null;
  lcData       = null;
  lcTypeFilter = 'all';

  document.getElementById('lcZipInput').value  = '';
  document.getElementById('lcUploadZone').classList.remove('lc-has-file');
  document.getElementById('lcUploadTitle').textContent = 'Click to browse for ZIP file';
  document.getElementById('lcUploadSub').textContent   = 'Select an AEM package ZIP (nested or flat)';
  document.getElementById('lcCheckBtn').disabled = true;
  document.getElementById('lcResetBtn').style.display = 'none';
  document.getElementById('lcStatus').textContent = '';
  document.getElementById('lcResults').style.display = 'none';
  document.getElementById('lcFixCard').style.display = 'none';
}

// ─── Run check ────────────────────────────────────────────────────────────────
async function lcCheck() {
  if (!lcFile) return;

  const btn = document.getElementById('lcCheckBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Scanning...';
  document.getElementById('lcStatus').textContent = '';
  document.getElementById('lcResults').style.display = 'none';

  const formData = new FormData();
  formData.append('zip', lcFile);

  try {
    const res  = await fetch('/api/link-checker/check', { method: 'POST', body: formData });
    const data = await res.json();

    if (!data.success) throw new Error(data.error || 'Unknown error');

    lcData = data;
    lcTypeFilter = 'all';
    lcRenderStats(data.stats);
    lcRenderTable();
    await lcDetectRoot();
    lcRenderFixPanel(data.stats);
    document.getElementById('lcResults').style.display = 'block';
    document.getElementById('lcResetBtn').style.display = '';
    document.getElementById('lcStatus').textContent =
      `${data.stats.totalFiles} files · ${data.stats.totalLinks.toLocaleString()} links found`;
  } catch (err) {
    document.getElementById('lcStatus').textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-search me-2"></i>Check Links';
  }
}

// ─── Stats cards ──────────────────────────────────────────────────────────────
function lcRenderStats(stats) {
  const shortCount  = stats.byType['short-path']  || 0;
  const abbvieCount = stats.byType['abbvie-abs']  || 0;
  const cards = [
    { label: 'Files with Links',   value: stats.totalFiles,          color: 'text-primary'                                        },
    { label: 'Total Links',        value: stats.totalLinks,          color: 'text-dark'                                           },
    { label: 'DAM Assets',         value: stats.byType.dam,          color: 'text-info'                                           },
    { label: 'Internal Pages',     value: stats.byType.internal,     color: 'text-success'                                        },
    { label: 'External',           value: stats.byType.external,     color: 'text-warning'                                        },
    { label: 'Scene7 (Classic)',    value: stats.byType['scene7']     || 0, color: 'text-danger'    },
    { label: 'DM Open API',        value: stats.byType['dm-openapi'] || 0, color: 'text-purple'   },
    { label: 'AEM Cloud',          value: stats.byType['aem-cloud'], color: 'text-secondary'                                      },
    { label: 'AbbVie Abs URLs ⚠', value: abbvieCount,               color: abbvieCount > 0 ? 'text-danger fw-bold' : 'text-muted' },
    { label: 'Short Paths ⚠',     value: shortCount,                color: shortCount  > 0 ? 'text-danger fw-bold' : 'text-muted' },
  ];

  document.getElementById('lcStatCards').innerHTML = cards.map(c => `
    <div class="col-auto">
      <div class="card lc-stat-card">
        <div class="card-body text-center py-3 px-4">
          <div class="fs-3 fw-bold ${c.color}">${Number(c.value).toLocaleString()}</div>
          <div class="text-muted" style="font-size:0.75rem">${c.label}</div>
        </div>
      </div>
    </div>`).join('');
}

// ─── Table rendering ──────────────────────────────────────────────────────────
function lcRenderTable() {
  const search = document.getElementById('lcSearch').value.toLowerCase();
  const tbody  = document.getElementById('lcTableBody');
  tbody.innerHTML = '';

  let visibleCount = 0;

  (lcData?.files || []).forEach((f, idx) => {
    // Type filter: skip files that have zero links of the filtered type
    if (lcTypeFilter !== 'all' && !(f.counts[lcTypeFilter] > 0)) return;

    // Search filter on file path OR any link URL
    if (search) {
      const fileMatch = f.file.toLowerCase().includes(search);
      const linkMatch = f.links.some(l => l.url.toLowerCase().includes(search));
      if (!fileMatch && !linkMatch) return;
    }

    visibleCount++;

    const rowId = `lc-row-${idx}`;
    const detailId = `lc-detail-${idx}`;

    // Count cells — highlight the active filter type; always warn on short-path counts
    const countCells = ['dam','internal','external','scene7','dm-openapi','aem-cloud','abbvie-abs','short-path'].map(t => {
      const cnt = f.counts[t] || 0;
      const warn = t === 'short-path' || t === 'abbvie-abs';
      let hl;
      if (lcTypeFilter === t && cnt > 0)   hl = ' fw-bold text-primary';
      else if (warn && cnt > 0)            hl = ' fw-bold text-warning';
      else if (cnt > 0)                    hl = '';
      else                                 hl = ' text-muted';
      return `<td class="text-center${hl}">${cnt || '—'}</td>`;
    }).join('');

    tbody.insertAdjacentHTML('beforeend', `
      <tr id="${rowId}" class="lc-file-row" onclick="lcToggleDetail(${idx})" style="cursor:pointer">
        <td class="text-center">
          <i class="bi bi-chevron-right lc-chevron" id="lc-chev-${idx}" style="font-size:0.75rem;color:#6c757d;transition:transform 0.15s"></i>
        </td>
        <td class="small font-monospace lc-file-path" title="${escHtml(f.file)}">${escHtml(f.file)}</td>
        <td class="text-center fw-semibold">${f.linkCount}</td>
        ${countCells}
      </tr>
      <tr id="${detailId}" style="display:none">
        <td colspan="11" class="p-0">
          <div class="lc-detail-panel" id="lc-panel-${idx}"></div>
        </td>
      </tr>`);
  });

  document.getElementById('lcNoResults').style.display = visibleCount === 0 ? 'block' : 'none';
  document.getElementById('lcTable').style.display     = visibleCount === 0 ? 'none'  : '';
}

// ─── Expand / collapse detail ─────────────────────────────────────────────────
function lcToggleDetail(idx) {
  const detailRow = document.getElementById(`lc-detail-${idx}`);
  const chevron   = document.getElementById(`lc-chev-${idx}`);
  const panel     = document.getElementById(`lc-panel-${idx}`);
  const isOpen    = detailRow.style.display !== 'none';

  if (isOpen) {
    detailRow.style.display = 'none';
    chevron.style.transform = '';
  } else {
    detailRow.style.display = '';
    chevron.style.transform = 'rotate(90deg)';
    if (!panel.dataset.built) {
      panel.dataset.built = '1';
      lcBuildDetailPanel(panel, lcData.files[idx]);
    }
  }
}

function lcBuildDetailPanel(panel, f) {
  const search = document.getElementById('lcSearch').value.toLowerCase();

  const links = lcTypeFilter === 'all'
    ? f.links
    : f.links.filter(l => l.type === lcTypeFilter);

  const filtered = search
    ? links.filter(l => l.url.toLowerCase().includes(search))
    : links;

  if (!filtered.length) {
    panel.innerHTML = '<div class="p-3 text-muted small">No links match current filter.</div>';
    return;
  }

  const hasShortPaths  = filtered.some(l => l.type === 'short-path' || l.type === 'abbvie-abs');
  const showSuggestions = hasShortPaths && lcSiteRoots.length > 0;

  panel.innerHTML = `
    <table class="table table-sm mb-0 lc-link-table">
      <thead><tr>
        <th style="width:110px">Type</th>
        <th>URL / Path</th>
        ${showSuggestions ? '<th>Suggested Full Path</th>' : ''}
      </tr></thead>
      <tbody>
        ${filtered.map(l => {
          const isShort    = l.type === 'short-path' || l.type === 'abbvie-abs';
          const suggestion = isShort && lcSiteRoots.length > 0
            ? lcSiteRoots.map(r => `<span class="d-block">${escHtml(r + l.url)}</span>`).join('')
            : '';
          return `<tr${isShort ? ' class="table-warning"' : ''}>
            <td><span class="badge ${LC_TYPE_LABELS[l.type]?.cls || 'bg-secondary'}">${LC_TYPE_LABELS[l.type]?.label || l.type}</span></td>
            <td class="small font-monospace lc-link-url" title="${escHtml(l.url)}">${escHtml(l.url)}</td>
            ${showSuggestions ? `<td class="small font-monospace text-success">${suggestion}</td>` : ''}
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

// ─── Fix short paths ──────────────────────────────────────────────────────────
// ── Detect site root from the uploaded ZIP ────────────────────────────────────
async function lcDetectRoot() {
  const sessionId = lcData?.sessionId;
  if (!sessionId) return;
  try {
    const res = await fetch('/api/link-checker/detect-root', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    const { siteRoot, locales } = await res.json();
    document.getElementById('lcDetectedRoot').textContent   = siteRoot || '(not detected)';
    document.getElementById('lcDetectedLocales').textContent = locales?.join(' · ') || '—';
    const override = document.getElementById('lcRootOverride');
    if (override) override.placeholder = siteRoot || '/content/site/root';
  } catch {
    document.getElementById('lcDetectedRoot').textContent = '(error detecting root)';
  }
}

function lcToggleRootOverride() {
  const wrap = document.getElementById('lcRootOverrideWrap');
  if (wrap) wrap.style.display = wrap.style.display === 'none' ? '' : 'none';
}

function lcGetEffectiveSiteRoot() {
  const override = document.getElementById('lcRootOverride')?.value.trim();
  if (override) return override;
  return document.getElementById('lcDetectedRoot')?.textContent.trim() || '';
}

// ── Render fix panel based on issue counts ────────────────────────────────────
async function lcRenderFixPanel(stats) {
  const shortCount  = stats.byType['short-path']  || 0;
  const scene7Count = stats.byType['scene7']       || 0;
  const absCount    = stats.byType['abbvie-abs']   || 0;
  const hasIssues   = shortCount > 0 || scene7Count > 0 || absCount > 0;

  const card = document.getElementById('lcFixCard');
  // Always show card so DAM normalization is accessible even if no other issues detected
  card.style.display = 'block';

  // Short paths section
  const spSec = document.getElementById('lcFixSection-shortPath');
  if (spSec) {
    spSec.style.display = shortCount > 0 ? '' : 'none';
    const badge = document.getElementById('lcFixCount-shortPath');
    if (badge) badge.textContent = shortCount;
  }

  // Scene7 section
  const s7Sec = document.getElementById('lcFixSection-scene7');
  if (s7Sec) {
    s7Sec.style.display = scene7Count > 0 ? '' : 'none';
    const badge = document.getElementById('lcFixCount-scene7');
    if (badge) badge.textContent = scene7Count;
    // Populate CSV env dropdown from Image/Asset tool
    await lcLoadScene7Envs();
  }

  // AbbVie abs section
  const absSec = document.getElementById('lcFixSection-abbvieAbs');
  if (absSec) {
    absSec.style.display = absCount > 0 ? '' : 'none';
    const badge = document.getElementById('lcFixCount-abbvieAbs');
    if (badge) badge.textContent = absCount;
  }

  document.getElementById('lcFixStatus').textContent = '';
}

// Populate the Scene7 CSV environment dropdown from the Image/Asset tool's csv-status
// Mirror server.js envSlug() so the dropdown value matches asset-map-{slug}.csv
function lcEnvSlug(name) {
  return (name || 'default').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

async function lcLoadScene7Envs() {
  const sel = document.getElementById('lcFix-scene7-env');
  if (!sel) return;
  try {
    const res  = await fetch('/api/image/csv-status');
    const data = await res.json();
    // response shape: { statuses: [{ name, exists, ... }, ...] }
    const statuses  = data.statuses || data || [];
    const available = statuses.filter(e => e.exists);
    if (!available.length) {
      sel.innerHTML = '<option value="">— no CSV available — build one in Image/Asset tool —</option>';
      return;
    }
    sel.innerHTML = '<option value="">— select environment —</option>' +
      available.map(e => `<option value="${escHtml(lcEnvSlug(e.name))}">${escHtml(e.name)}</option>`).join('');
  } catch {
    sel.innerHTML = '<option value="">— could not load environments —</option>';
  }
}

// ── Fix all issues and download patched ZIP ────────────────────────────────────
async function lcFixIssues() {
  const sessionId = lcData?.sessionId;
  if (!sessionId) { alert('No active session — please re-upload the ZIP.'); return; }

  const siteRoot = lcGetEffectiveSiteRoot();

  const fixes = { siteRoot };

  if (document.getElementById('lcFix-check-shortPath')?.checked) {
    fixes.shortPath = true;
  }
  if (document.getElementById('lcFix-check-scene7')?.checked) {
    const csvEnv = document.getElementById('lcFix-scene7-env')?.value;
    if (csvEnv) {
      fixes.scene7 = { csvEnv };
    } else {
      // Scene7 is ticked but no environment chosen — warn instead of silently skipping
      const status = document.getElementById('lcFixStatus');
      status.textContent = 'Select a Scene7 asset-map environment (the dropdown) before fixing — or uncheck "Scene7 URLs".';
      status.className = 'small text-danger fw-semibold';
      document.getElementById('lcFix-scene7-env')?.focus();
      return;
    }
  }
  if (document.getElementById('lcFix-check-absBaseUrl')?.checked) {
    const baseDomain = document.getElementById('lcFix-absBaseUrl-domain')?.value.trim() || 'abbvie.com';
    fixes.absBaseUrl = { baseDomain };
  }
  if (document.getElementById('lcFix-check-damPaths')?.checked) {
    const correctRoot = document.getElementById('lcFix-dam-correct')?.value.trim();
    const oldStr      = document.getElementById('lcFix-dam-old')?.value.trim();
    const oldRoots    = oldStr ? oldStr.split(',').map(s => s.trim()).filter(Boolean) : [];
    if (correctRoot && oldRoots.length) {
      fixes.damPaths = { correctRoot, oldRoots };
    }
  }

  const btn = document.getElementById('lcFixAllBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Processing…';
  const status = document.getElementById('lcFixStatus');
  status.textContent = '';
  status.className = 'small text-muted';

  try {
    const res = await fetch('/api/link-checker/fix-issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, fixes }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }

    const fixedCount      = res.headers.get('X-Fixed-Count')      || '0';
    const unmatchedScene7 = res.headers.get('X-Unmatched-Scene7') || '0';
    const changeCount     = res.headers.get('X-Change-Count')     || '0';
    const reportId        = res.headers.get('X-Report-Id')        || '';

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: 'fixed-package.zip' });
    a.click();
    URL.revokeObjectURL(url);

    let msg = `Done — ${fixedCount} file(s) patched, ${changeCount} URL(s) rewritten. ZIP download started.`;
    if (parseInt(unmatchedScene7, 10) > 0) {
      msg += ` ${unmatchedScene7} Scene7 URL(s) had no CSV match and were left unchanged.`;
    }
    status.innerHTML = `${escHtml(msg)}` + (reportId
      ? ` <a href="/api/link-checker/fix-report/${encodeURIComponent(reportId)}" download="fix-change-report.csv" class="ms-1"><i class="bi bi-filetype-csv me-1"></i>Download change report (old → new URLs)</a>`
      : '');
    status.className = 'small text-success fw-semibold';

    // Session is consumed — reset so user knows to re-upload for another run
    lcData = { ...lcData, sessionId: null };
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'small text-danger';
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-download me-2"></i>Fix All &amp; Download ZIP';
  }
}

// ─── Type filter ──────────────────────────────────────────────────────────────
function lcSetTypeFilter(type) {
  lcTypeFilter = type;

  document.querySelectorAll('.lc-type-btn').forEach(btn => {
    const isActive = btn.dataset.type === type;
    btn.className = `btn btn-sm lc-type-btn ${isActive ? 'btn-primary' : 'btn-outline-secondary'}`;
  });

  lcRenderTable();
}

// ─── Search ───────────────────────────────────────────────────────────────────
function lcApplyFilters() { lcRenderTable(); }

// ─── Export CSV ───────────────────────────────────────────────────────────────
async function lcExportCsv() {
  if (!lcData) return;

  const files = lcTypeFilter === 'all'
    ? lcData.files
    : lcData.files.map(f => ({
        ...f,
        links: f.links.filter(l => l.type === lcTypeFilter)
      })).filter(f => f.links.length > 0);

  const res  = await fetch('/api/link-checker/export-csv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  });

  const blob = await res.blob();
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'link-report.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// ══════════════════════════════════════════════════════════════════════════════
// PACKAGE CREATOR TOOL
// ══════════════════════════════════════════════════════════════════════════════

let pkgFilterPaths = [];   // [{ root, mode }]

function pkgGetMode() {
  return document.querySelector('input[name="pkgGlobalMode"]:checked')?.value || 'replace';
}

function pkgParsePaths(text) {
  return text.split(/[\r\n,]+/).map(l => l.trim()).filter(l => l.startsWith('/'));
}

function pkgRenderPills() {
  const container = document.getElementById('pkgPathPills');
  container.innerHTML = pkgFilterPaths.map((f, i) => `
    <span class="badge bg-light text-dark border d-inline-flex align-items-center gap-2 py-2 px-2">
      <span class="badge bg-secondary">${escHtml(f.mode)}</span>
      <span class="font-monospace">${escHtml(f.root)}</span>
      <button type="button" class="btn-close btn-close-sm" aria-label="Remove" data-i="${i}"
        style="font-size:.6rem" onclick="pkgRemovePath(${i})"></button>
    </span>`).join('');
}

function pkgRemovePath(i) {
  pkgFilterPaths.splice(i, 1);
  pkgRenderPills();
}

function pkgSyncPaths() {
  const mode = pkgGetMode();
  pkgFilterPaths = pkgParsePaths(document.getElementById('pkgPathsInput').value).map(root => ({ root, mode }));
  pkgRenderPills();
}

// Pre-fill AEM creds from the Image/Asset tool's saved config (client-side convenience)
async function pkgUseImageCreds() {
  try {
    const res  = await fetch('/api/image/site-config');
    const data = await res.json();
    const env  = (data.environments || data || []).find(e => e.aemUrl || e.host) || {};
    if (env.aemUrl || env.host) document.getElementById('pkgHost').value = env.aemUrl || env.host;
    if (env.username) document.getElementById('pkgUsername').value = env.username;
  } catch { /* no-op — config may not exist */ }
}

async function pkgTestConnection() {
  const badge = document.getElementById('pkgConnStatus');
  badge.className = 'small text-muted';
  badge.textContent = 'Testing…';
  try {
    const res = await fetch('/api/pkg/test-connection', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host:     val('pkgHost'),
        username: val('pkgUsername'),
        password: document.getElementById('pkgPassword').value,
      }),
    });
    const data = await res.json();
    badge.className = data.success ? 'small text-success fw-semibold' : 'small text-danger fw-semibold';
    badge.textContent = data.success ? '✔ Connected' : '✖ ' + data.message;
  } catch {
    badge.className = 'small text-danger fw-semibold';
    badge.textContent = '✖ Network error';
  }
}

function pkgValidate() {
  const errors = [];
  if (!val('pkgHost'))  errors.push('Host URL is required');
  if (!val('pkgName'))  errors.push('Package name is required');
  if (!val('pkgGroup')) errors.push('Group name is required');
  if (pkgFilterPaths.length === 0) errors.push('Add at least one content path');
  return errors;
}

async function pkgRunCreate(buildAfter) {
  pkgSyncPaths();                       // pick up any un-synced textarea content
  const errors = pkgValidate();
  if (errors.length) { alert(errors.join('\n')); return; }

  const logSection = document.getElementById('pkgLogSection');
  const logSteps   = document.getElementById('pkgLogSteps');
  const banner     = document.getElementById('pkgResultBanner');
  logSection.style.display = '';
  logSteps.innerHTML = '';
  banner.style.display = 'none';
  logSection.scrollIntoView({ behavior: 'smooth' });

  const btnCreate = document.getElementById('pkgBtnCreate');
  const btnBuild  = document.getElementById('pkgBtnCreateBuild');
  btnCreate.disabled = btnBuild.disabled = true;

  const stepEls = {};
  const addStep = (id, label) => {
    const el = document.createElement('div');
    el.className = 'd-flex align-items-center gap-2';
    el.innerHTML = `<span class="spinner-border spinner-border-sm text-primary" id="pkgspin-${id}"></span>
      <div><div class="fw-semibold small">${label}</div>
      <div class="text-muted small" id="pkgmsg-${id}">Waiting…</div></div>`;
    logSteps.appendChild(el);
    stepEls[id] = el;
  };
  const updateStep = (id, status, message) => {
    const el = stepEls[id];
    if (!el) return;
    const spin = el.querySelector(`#pkgspin-${id}`);
    if (spin) {
      const icon = document.createElement('span');
      icon.className = status === 'done' ? 'text-success fw-bold' : status === 'error' ? 'text-danger fw-bold' : 'text-primary';
      icon.textContent = status === 'done' ? '✔' : status === 'error' ? '✖' : '⟳';
      spin.replaceWith(icon);
    }
    el.querySelector(`#pkgmsg-${id}`).textContent = message;
  };

  addStep('create',  'Creating package');
  addStep('filters', 'Applying filters');
  if (buildAfter) addStep('build', 'Building package');

  const payload = {
    host:     val('pkgHost'),
    username: val('pkgUsername'),
    password: document.getElementById('pkgPassword').value,
    packageDetails: {
      packageName: val('pkgName'),
      groupName:   val('pkgGroup'),
      version:     val('pkgVersion') || '1.0',
      description: val('pkgDesc'),
    },
    filters: pkgFilterPaths,
    build: buildAfter,
  };

  try {
    const res = await fetch('/api/pkg/create-package', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const evt = JSON.parse(line);
        if (evt.step === 'done') {
          banner.className = 'alert alert-success mt-3 mb-0';
          banner.innerHTML = `Package ready — <a href="${escHtml(evt.message)}" target="_blank" rel="noopener">Open in Package Manager ↗</a>`;
          banner.style.display = '';
        } else {
          updateStep(evt.step, evt.status, evt.message);
        }
      }
    }
  } catch (err) {
    banner.className = 'alert alert-danger mt-3 mb-0';
    banner.textContent = 'Unexpected error: ' + err.message;
    banner.style.display = '';
  } finally {
    btnCreate.disabled = btnBuild.disabled = false;
  }
}

function pkgInit() {
  document.getElementById('pkgPathsInput')?.addEventListener('input', pkgSyncPaths);
  document.querySelectorAll('input[name="pkgGlobalMode"]').forEach(r => r.addEventListener('change', pkgSyncPaths));
  document.getElementById('pkgFileUpload')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    document.getElementById('pkgFileName').textContent = file.name;
    const reader = new FileReader();
    reader.onload = (ev) => {
      document.getElementById('pkgPathsInput').value = ev.target.result;
      pkgSyncPaths();
    };
    reader.readAsText(file);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// XMOD S7 PACKAGE UPDATER TOOL
// ══════════════════════════════════════════════════════════════════════════════

let puData = null;   // { sessionId, isBundle, sourcePath, ... } from last inspect

async function puInspect() {
  const fileInput = document.getElementById('puFile');
  const file = fileInput?.files?.[0];
  const status = document.getElementById('puInspectStatus');
  if (!file) { status.className = 'small text-danger'; status.textContent = 'Select a ZIP first.'; return; }

  const btn = document.getElementById('puInspectBtn');
  btn.disabled = true;
  status.className = 'small text-muted';
  status.textContent = 'Inspecting…';

  const fd = new FormData();
  fd.append('zip', file);
  const mapping = document.getElementById('puMappingFile')?.files?.[0];
  if (mapping) fd.append('mapping', mapping);

  try {
    const res  = await fetch('/api/pkg-updater/inspect', { method: 'POST', body: fd });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Inspect failed');

    puData = data;
    document.getElementById('puIsBundle').textContent = data.isBundle ? 'Bundle' : 'Plain content ZIP';
    document.getElementById('puInnerZip').textContent = data.innerZipName ? `(inner: ${data.innerZipName})` : '';
    document.getElementById('puSourcePath').textContent = data.sourcePath || '(not detected)';
    document.getElementById('puAssetCount').textContent = data.assetCount;
    if (data.sourcePath) document.getElementById('puTargetPath').placeholder = data.sourcePath;

    show('puResultsCard');
    show('puProcessCard');
    document.getElementById('puStatus').textContent = '';
    document.getElementById('puLog').style.display = 'none';
    status.className = 'small text-success fw-semibold';
    status.textContent = '✔ Inspected';
  } catch (err) {
    status.className = 'small text-danger fw-semibold';
    status.textContent = '✖ ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

async function puProcess() {
  if (!puData?.sessionId) { alert('Inspect a ZIP first.'); return; }
  const targetPath = val('puTargetPath');

  if (!targetPath && puData.assetCount === 0) {
    const s = document.getElementById('puStatus');
    s.className = 'small text-danger fw-semibold';
    s.textContent = 'Nothing to do — enter a target path to move, or upload a bundle / asset-mapping.json for replacement.';
    return;
  }

  const btn = document.getElementById('puProcessBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Processing…';
  const status = document.getElementById('puStatus');
  status.className = 'small text-muted';
  status.textContent = '';

  try {
    const res = await fetch('/api/pkg-updater/process', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: puData.sessionId, targetPath }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }

    const modified = res.headers.get('X-Modified-Count') || '0';
    const source   = res.headers.get('X-Source-Path') || '';
    let logLines = [];
    try { logLines = JSON.parse(atob(res.headers.get('X-Pkg-Log') || '')); } catch {}

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: 'package_updated.zip' });
    a.click();
    URL.revokeObjectURL(url);

    let msg = `Done — ${modified} file(s) modified/created. Download started.`;
    if (targetPath && source) msg += ` Moved ${source} → ${targetPath}.`;
    status.className = 'small text-success fw-semibold';
    status.textContent = msg;

    const logEl = document.getElementById('puLog');
    if (logLines.length) { logEl.textContent = logLines.join('\n'); logEl.style.display = ''; }
    else logEl.style.display = 'none';

    puData = { ...puData, sessionId: null };   // session consumed
  } catch (err) {
    status.className = 'small text-danger fw-semibold';
    status.textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-arrow-repeat me-1"></i>Process &amp; Download ZIP';
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP
// ══════════════════════════════════════════════════════════════════════════════

window.addEventListener('DOMContentLoaded', () => {
  metaInit();
  imageInit();
  lcLoadSiteRoots();
  pkgInit();
});
