// ══════════════════════════════════════════════════════════════════════════════
// SHARED UTILITIES
// ══════════════════════════════════════════════════════════════════════════════

function switchTool(name) {
  ['pkgupd', 'meta', 'propupdater', 'image', 'linkchecker', 'pkg', 'lighthouse', 'info'].forEach(t => {
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
  savedList.forEach(m => { if (m.aem) savedMap[m.aem] = m; });

  const samples = {};
  allProps.forEach(p => {
    for (const page of allPages) {
      if (page.properties[p]) { samples[p] = page.properties[p]; break; }
    }
  });

  const tbody = document.getElementById('mappingBody');
  tbody.innerHTML = '';

  // Discovered AEM properties → source-mapped rows
  allProps.forEach(prop => {
    const sample       = samples[prop] || '';
    const saved        = savedMap[prop];
    const edsVal       = saved?.eds || '';
    const transformVal = saved?.transform || '';
    const typeHint     = saved?.typeHint || '';
    tbody.insertAdjacentHTML('beforeend', mappingRow(prop, sample, edsVal, transformVal, '', 'String', false, typeHint));
  });

  // Saved manual AEM-source rows (typed in by user) that are not in discoveredProps
  const allPropsSet = new Set(allProps);
  savedList.filter(m => m.aem && m.manual && !allPropsSet.has(m.aem)).forEach(m => {
    tbody.insertAdjacentHTML('beforeend', mappingRow(m.aem, '', m.eds, m.transform || '', '', 'String', true, m.typeHint || ''));
  });

  // Saved constant (custom) properties → constant rows (no AEM source)
  savedList.filter(m => !m.aem && m.eds).forEach(m => {
    tbody.insertAdjacentHTML('beforeend', mappingRow('', '', m.eds, '', m.value || '', m.valueType || 'String'));
  });

  document.getElementById('mappingSection').style.display = 'block';
}

const TRANSFORMS = [
  { value: '',                 label: 'None' },
  { value: 'aem-tag-to-eds',   label: 'AEM Tag → EDS  (ns:path → corporate:ns/path)' },
  { value: 'dam-path-to-eds',  label: 'DAM Path → EDS  (inserts /corporate/)' },
  { value: 'dam-to-dm-openapi', label: 'DAM Path → DM Open API URL  (CSV lookup)' }
];

function transformOptions(selected = '') {
  return TRANSFORMS.map(t =>
    `<option value="${t.value}" ${t.value === selected ? 'selected' : ''}>${escHtml(t.label)}</option>`
  ).join('');
}

// AEM/JCR standard value types for custom (constant) EDS properties
const VALUE_TYPES = [
  { value: 'String',   label: 'String' },
  { value: 'String[]', label: 'String (multi-value)' },
  { value: 'Boolean',  label: 'Boolean' },
  { value: 'Date',     label: 'Date' },
  { value: 'Long',     label: 'Long' },
  { value: 'Double',   label: 'Double' },
];

function valueTypeOptions(selected = 'String') {
  return VALUE_TYPES.map(t =>
    `<option value="${t.value}" ${t.value === selected ? 'selected' : ''}>${escHtml(t.label)}</option>`
  ).join('');
}

// Type hint options for AEM-source rows — "auto" defers to array detection at runtime;
// setting String[] forces @TypeHint=String[] even when AEM serialises a single value as a plain string.
const TYPE_HINTS = [
  { value: '',         label: 'auto (detect from source)' },
  { value: 'String[]', label: 'String[] (force multi-value)' },
  { value: 'Boolean',  label: 'Boolean' },
  { value: 'Date',     label: 'Date' },
  { value: 'Long',     label: 'Long' },
  { value: 'Double',   label: 'Double' },
];

function typeHintOptions(selected = '') {
  return TYPE_HINTS.map(t =>
    `<option value="${t.value}" ${t.value === selected ? 'selected' : ''}>${escHtml(t.label)}</option>`
  ).join('');

}

// Row types:
//   discovered (aemProp set, manualAem false) — AEM cell is a read-only <code> tag
//   manual     (aemProp set, manualAem true)  — AEM cell is an editable input; user typed the property name
//   constant   (aemProp empty, manualAem false) — no AEM source; literal value written to every page
// typeHint (AEM-source rows only): forces @TypeHint on the Sling POST even when AEM serialises a
//   single-value String[] as a plain string. Empty = auto-detect from whether value is array.
function mappingRow(aemProp, sample, edsVal = '', transformVal = '', value = '', valueType = 'String', manualAem = false, typeHint = '') {
  const isConstant = !aemProp && !manualAem;
  const isManual   = manualAem;
  const sid = `eds_${(aemProp || 'row_' + Math.random().toString(36).slice(2, 8)).replace(/[^a-zA-Z0-9]/g, '_')}`;

  let aemCell;
  if (isConstant) {
    aemCell = `<input type="text" class="form-control form-control-sm aem-input" placeholder="(constant)" disabled />`;
  } else if (isManual) {
    aemCell = `<input type="text" class="form-control form-control-sm aem-input" placeholder="AEM property name" value="${escHtml(aemProp)}" />`;
  } else {
    aemCell = `<code class="text-primary">${escHtml(aemProp)}</code>`;
  }

  const badge = isConstant ? '<span class="badge bg-secondary me-1">constant</span>'
              : isManual   ? '<span class="badge bg-info text-dark me-1">manual</span>'
              : '';

  // Constants use valueTypeOptions (the type written to Sling); AEM-source rows use typeHintOptions
  // (override for when AEM serialises a single-value String[] as a plain string).
  const typeCell = isConstant
    ? `<select class="form-select form-select-sm type-input">${valueTypeOptions(valueType)}</select>`
    : `<select class="form-select form-select-sm type-input" title="Force @TypeHint on the Sling POST. Use String[] when AEM may return a single-value multi-value property as a plain string.">${typeHintOptions(typeHint)}</select>`;

  return `
    <tr data-aem="${escHtml(aemProp)}" data-custom="${isConstant ? '1' : '0'}" data-manual="${isManual ? '1' : '0'}">
      <td>${badge}${aemCell}</td>
      <td class="text-muted small text-truncate" style="max-width:150px" title="${escHtml(sample)}">${escHtml(sample)}</td>
      <td>
        <input type="text" class="form-control form-control-sm eds-input" id="${sid}"
          placeholder="eds property name" value="${escHtml(edsVal)}" />
      </td>
      <td>
        <select class="form-select form-select-sm transform-input" ${isConstant ? 'disabled title="constants are not transformed"' : ''}>
          ${transformOptions(transformVal)}
        </select>
      </td>
      <td>
        <input type="text" class="form-control form-control-sm value-input"
          placeholder="${isConstant ? 'literal value (comma-separated for multi)' : '— from source —'}"
          value="${escHtml(value)}" ${isConstant ? '' : 'disabled'} />
      </td>
      <td>${typeCell}</td>
      <td>
        <button class="btn btn-sm btn-link text-danger p-0" onclick="this.closest('tr').remove()" title="Remove">
          <i class="bi bi-trash"></i>
        </button>
      </td>
    </tr>`;
}

function addCustomMapping() {
  document.getElementById('mappingBody').insertAdjacentHTML('beforeend', mappingRow('', '', '', '', '', 'String'));
}

function addAemSourceMapping() {
  document.getElementById('mappingBody').insertAdjacentHTML('beforeend', mappingRow('', '', '', '', '', 'String', true));
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
    const isCustom  = row.getAttribute('data-custom') === '1';
    const eds       = row.querySelector('.eds-input')?.value.trim();
    if (!eds) return;

    if (isCustom) {
      // Constant / custom EDS property: literal value + AEM value type
      const value     = row.querySelector('.value-input')?.value ?? '';
      const valueType = row.querySelector('.type-input')?.value || 'String';
      if (value !== '') mapping.push({ eds, value, valueType });
    } else {
      const isManual  = row.getAttribute('data-manual') === '1';
      // Manual rows have an editable AEM input; discovered rows store the prop in data-aem
      const aem       = isManual
        ? row.querySelector('.aem-input')?.value.trim()
        : row.getAttribute('data-aem');
      const transform = row.querySelector('.transform-input')?.value || '';
      const typeHint  = row.querySelector('.type-input')?.value || '';
      if (aem) {
        const entry = { aem, eds };
        if (transform) entry.transform = transform;
        if (typeHint)  entry.typeHint  = typeHint;
        if (isManual)  entry.manual    = true;
        mapping.push(entry);
      }
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
  // Whole-segment match. Default (toggle off): only the page whose path ENDS with
  // the segment — e.g. "who-we-are" → just .../who-we-are. Toggle on ("Include
  // children"): also match descendant pages (.../who-we-are/**). Empty = show all.
  const q = document.getElementById('pageFilter').value.trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  const subtree = document.getElementById('pageFilterSubtree')?.checked;
  document.querySelectorAll('#pagesBody tr').forEach(row => {
    if (!q) { row.style.display = ''; return; }
    const paths = [row.getAttribute('data-path'), row.getAttribute('data-target')]
      .filter(Boolean)
      .map(p => p.replace(/\/+$/, '').toLowerCase());
    const seg = '/' + q;
    const match = paths.some(p =>
      p === q || p.endsWith(seg) || (subtree && p.includes(seg + '/'))
    );
    row.style.display = match ? '' : 'none';
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
    if (transform === 'dam-to-dm-openapi') {
      // Client can't reach the CSV — show the /corporate path as a placeholder.
      // The Preview resolves the real DM URL via the server; the update always does.
      const s = String(v);
      return s.includes('/content/dam/corporate/') ? s : s.replace('/content/dam/', '/content/dam/corporate/');
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

  // If any mapping resolves to a DM Open API URL, batch-resolve those source values
  // against the selected asset-map environment so the preview shows the real DM URLs.
  const dmEnv   = document.getElementById('metaAssetEnv')?.value || '';
  const needsDm = mapping.some(m => m.transform === 'dam-to-dm-openapi');
  let dmResolved = null;
  if (needsDm && dmEnv) {
    const inputs = [];
    selectedPages.forEach(page => mapping.forEach(({ aem, transform }) => {
      if (transform === 'dam-to-dm-openapi' && page.properties[aem] !== undefined) inputs.push(page.properties[aem]);
    }));
    try {
      const resp = await fetchJSON('/api/meta/resolve-dm', { method: 'POST', body: { env: dmEnv, values: inputs } });
      dmResolved = new Map(inputs.map((v, i) => [JSON.stringify(v), resp.resolved[i]]));
    } catch (e) { alert('DM resolve failed: ' + (e.message || e)); }
  } else if (needsDm && !dmEnv) {
    alert('A mapping uses "DAM → DM Open API URL". Select an "Asset-map env" to preview the resolved DM URLs (otherwise the /corporate path is shown).');
  }

  // Constant / custom properties (no AEM source) — apply to every selected page; show once.
  mapping.filter(m => !m.aem && m.eds && m.value !== undefined && m.value !== '').forEach(m => {
    rowCount++;
    const disp = m.valueType === 'String[]'
      ? String(m.value).split(',').map(s => s.trim()).filter(Boolean).join(' | ')
      : String(m.value);
    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td class="small text-muted fst-italic">(all selected pages)</td>
        <td><span class="badge bg-secondary">constant</span></td>
        <td class="text-muted small">${escHtml(m.valueType || 'String')}</td>
        <td><code class="text-success">${escHtml(m.eds)}</code></td>
        <td class="small text-warning fw-semibold">${escHtml(disp)}</td>
      </tr>`);
  });

  selectedPages.forEach(page => {
    mapping.forEach(({ aem, eds, transform }) => {
      if (aem && page.properties[aem] !== undefined) {
        rowCount++;
        const sourceVal    = page.properties[aem];
        const targetVal    = (transform === 'dam-to-dm-openapi' && dmResolved && dmResolved.has(JSON.stringify(sourceVal)))
          ? dmResolved.get(JSON.stringify(sourceVal))
          : clientTransform(transform, sourceVal);
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

  const assetEnv = document.getElementById('metaAssetEnv')?.value || '';
  if (mapping.some(m => m.transform === 'dam-to-dm-openapi') && !assetEnv) {
    return alert('A mapping uses "DAM → DM Open API URL" — select an "Asset-map env" before running the update.');
  }

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
    body: { selectedPaths: selected, assetEnv }
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
  metaLoadAssetEnvs();
}

// Populate the asset-map environment dropdown (used by the DAM → DM Open API transform).
// Only environments that already have a built CSV are offered.
async function metaLoadAssetEnvs() {
  const sel = document.getElementById('metaAssetEnv');
  if (!sel) return;
  try {
    const data = await fetchJSON('/api/image/csv-status');
    const built = (data.statuses || []).filter(s => s.exists);
    sel.innerHTML = '<option value="">— none —</option>' +
      built.map(s => `<option value="${escHtml(s.name)}">${escHtml(s.name)}</option>`).join('');
  } catch {
    sel.innerHTML = '<option value="">— none —</option>';
  }
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
    const ppSelect     = document.getElementById('ppEnv');

    select.innerHTML       = '<option value="">— Select environment —</option>';
    targetSelect.innerHTML = '<option value="">— Select target environment —</option>';
    swapSelect.innerHTML   = '<option value="">— Select target environment —</option>';
    if (ppSelect) ppSelect.innerHTML = '<option value="">— Select environment —</option>';

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

      if (ppSelect) {
        const pOpt = document.createElement('option');
        pOpt.value = env.name;
        pOpt.textContent = env.name;
        ppSelect.appendChild(pOpt);
      }
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
        const { total, replaced, skipped = 0, filesProcessed } = data.stats;
        document.getElementById('swapStatTotal').textContent    = total.toLocaleString();
        document.getElementById('swapStatReplaced').textContent = replaced.toLocaleString();
        document.getElementById('swapStatFiles').textContent    = filesProcessed.toLocaleString();
        show('swapResultsWrap');
        show('swapDownloadRow');
        const skipNote = skipped > 0
          ? ` ${skipped.toLocaleString()} already on "${targetEnv}" — left unchanged (see report, status column).`
          : '';
        showBanner('swapBanner', 'success', `✓ Domain swapped to "${targetEnv}" — ${replaced} URL(s) updated across ${filesProcessed} file(s).${skipNote}`);
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
// MIGRATION QA — LINK CHECKER TOOL
// ══════════════════════════════════════════════════════════════════════════════

let lcFile = null, lcSessionId = null, lcAnalysis = null;

const LC_CHECKS = [
  { key: 'shortPath', label: 'Short paths',          icon: 'bi-signpost-split',   desc: 'Relative page links not rooted at the site root' },
  { key: 'absolute',  label: 'Absolute URLs',        icon: 'bi-globe',            desc: 'Internal pages written as full http(s) URLs' },
  { key: 'pdf',       label: 'PDFs not on DM',       icon: 'bi-file-earmark-pdf', desc: 'PDF assets still on /content/dam' },
  { key: 'dam',       label: 'DAM assets not on DM', icon: 'bi-images',           desc: 'Images / assets still on /content/dam' },
  { key: 'scene7',    label: 'Absolute Scene7 URLs', icon: 'bi-link-45deg',       desc: 'Legacy scene7.com delivery URLs' },
];

async function lcInit() {
  try {
    // List ALL configured environments (same source as the Image/Asset tab), and
    // annotate each with whether it has a built asset-map CSV (needed for PDF/DAM/Scene7 → DM).
    const [cfg, status] = await Promise.all([
      fetch('/api/image/site-config').then(r => r.json()),
      fetch('/api/image/csv-status').then(r => r.json()).catch(() => ({ statuses: [] })),
    ]);
    const built = new Set((status.statuses || []).filter(s => s.exists).map(s => s.name));
    const envs  = cfg.environments || [];
    const sel   = document.getElementById('lcEnv');
    if (sel) sel.innerHTML = '<option value="">— select —</option>' +
      envs.map(e => `<option value="${escHtml(e.name)}">${escHtml(e.name)}${built.has(e.name) ? ' ✓ CSV' : ' — no CSV'}</option>`).join('');
  } catch { /* no envs */ }
}

function lcOnFileSelected(input) {
  const file = input.files[0];
  if (!file) return;
  lcFile = file; lcSessionId = null; lcAnalysis = null;
  document.getElementById('lcUploadZone').classList.add('lc-has-file');
  document.getElementById('lcUploadTitle').textContent = file.name;
  document.getElementById('lcUploadSub').textContent   = `${(file.size / 1024 / 1024).toFixed(2)} MB — click to change`;
  document.getElementById('lcScanBtn').disabled = false;
  document.getElementById('lcReportBtn').disabled = true;   // enabled only after a successful Scan
  document.getElementById('lcResetBtn').style.display = '';
  document.getElementById('lcStatus').textContent = '';
  document.getElementById('lcReport').style.display = 'none';
  document.getElementById('lcReportPanel').style.display = 'none';
}

function lcReset() {
  lcFile = null; lcSessionId = null; lcAnalysis = null;
  document.getElementById('lcZipInput').value = '';
  document.getElementById('lcUploadZone').classList.remove('lc-has-file');
  document.getElementById('lcUploadTitle').textContent = 'Click to browse for a content-package ZIP';
  document.getElementById('lcUploadSub').textContent   = 'AEM package ZIP (nested or flat)';
  document.getElementById('lcScanBtn').disabled = true;
  document.getElementById('lcReportBtn').disabled = true;
  document.getElementById('lcResetBtn').style.display = 'none';
  document.getElementById('lcReport').style.display = 'none';
  document.getElementById('lcReportPanel').style.display = 'none';
  document.getElementById('lcStatus').textContent = '';
}

// Upload once → create a server-side session. Returns sessionId.
async function lcEnsureSession() {
  if (lcSessionId) return lcSessionId;
  const fd = new FormData(); fd.append('zip', lcFile);
  const res = await (await fetch('/api/link-checker/check', { method: 'POST', body: fd })).json();
  if (!res.success) throw new Error(res.error || 'Upload failed');
  lcSessionId = res.sessionId;
  return lcSessionId;
}

async function lcDetectRoot() {
  if (!lcFile) { alert('Upload a ZIP first.'); return; }
  const btn = document.getElementById('lcDetectBtn'); btn.disabled = true;
  try {
    await lcEnsureSession();
    const info = await (await fetch('/api/link-checker/detect-root', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: lcSessionId }),
    })).json();
    if (info.siteRoot) document.getElementById('lcSiteRoot').value = info.siteRoot;
    document.getElementById('lcStatus').textContent = info.siteRoot
      ? `Detected root: ${info.siteRoot}` : 'Could not detect a root — enter it manually.';
  } catch (e) { document.getElementById('lcStatus').textContent = e.message; }
  finally { btn.disabled = false; }
}

async function lcScan() {
  if (!lcFile) return;
  const siteRoot = document.getElementById('lcSiteRoot').value.trim();
  if (!siteRoot.startsWith('/content/')) { alert('Enter a valid site root starting with /content/'); return; }
  const env = document.getElementById('lcEnv').value;
  const btn = document.getElementById('lcScanBtn'); btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Scanning...';
  try {
    await lcEnsureSession();
    const res  = await fetch('/api/link-checker/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: lcSessionId, siteRoot, env }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Scan failed');
    lcAnalysis = data;
    lcRenderReport(data);
    document.getElementById('lcReportBtn').disabled = false;   // Scan done → Report available
  } catch (e) { alert(e.message); }
  finally { btn.disabled = false; btn.innerHTML = '<i class="bi bi-search me-2"></i>Scan'; }
}

function lcExamples(examples) {
  if (!examples || !examples.length) return '';
  return `<ul class="small text-muted mt-2 mb-0" style="max-height:180px;overflow:auto">` +
    examples.map(e => `<li><code>${escHtml(e.url)}</code> <span class="text-secondary">— ${escHtml(e.file)}</span></li>`).join('') +
    `</ul>`;
}

// Collapse/expand the nearest collapsible body (.lc-collapse, else .card-body) in a card.
function lcToggleCard(btn) {
  const card = btn.closest('.card'); if (!card) return;
  const body = card.querySelector('.lc-collapse') || card.querySelector('.card-body');
  if (!body) return;
  const hide = body.style.display !== 'none';
  body.style.display = hide ? 'none' : '';
  const icon = btn.querySelector('i');
  if (icon) icon.className = hide ? 'bi bi-chevron-down' : 'bi bi-chevron-up';
}
function lcChevron() {
  return `<button type="button" class="btn btn-sm btn-link text-muted p-0 lc-chev" title="Collapse / expand" onclick="event.stopPropagation();lcToggleCard(this)"><i class="bi bi-chevron-up"></i></button>`;
}

function lcCheckCard(c, count, examples) {
  const pass   = count === 0;
  const border = pass ? '#198754' : '#dc3545';
  const fixBtn = pass ? '' :
    `<button class="btn btn-sm btn-outline-success" onclick="lcFix(['${c.key}'])"><i class="bi bi-magic me-1"></i>Fix</button>`;
  const ex = lcExamples(examples);
  return `
  <div class="card mb-2" style="border-left:4px solid ${border}">
    <div class="card-body py-2">
      <div class="d-flex align-items-center gap-2 flex-wrap">
        <i class="bi ${c.icon} ${pass ? 'text-success' : 'text-danger'}"></i>
        <strong>${escHtml(c.label)}</strong>
        <span class="badge ${pass ? 'bg-success' : 'bg-danger'}">${pass ? 'PASS' : count}</span>
        <span class="text-muted small">— ${escHtml(c.desc)}</span>
        <div class="ms-auto d-flex align-items-center gap-2">${fixBtn}${ex ? lcChevron() : ''}</div>
      </div>
      ${ex ? `<div class="lc-collapse">${ex}</div>` : ''}
    </div>
  </div>`;
}

function lcRenderReport(data) {
  document.getElementById('lcSummary').innerHTML =
    `Scanned <strong>${data.pagesScanned}</strong> Franklin page(s) of ${data.xmlTotal} XML file(s). Site root <code>${escHtml(data.siteRoot)}</code>.` +
    (data.env
      ? ` Env <strong>${escHtml(data.env)}</strong>${data.csvExists ? '' : ' <span class="text-danger">(no CSV!)</span>'}.`
      : ' <span class="text-warning">No env selected — PDF/DAM/Scene7 fixes disabled.</span>');

  document.getElementById('lcChecks').innerHTML = [
    lcCheckCard(LC_CHECKS[0], data.checks.shortPath.count, data.checks.shortPath.examples),
    '<div id="lcAbsSlot"></div>',   // Absolute URLs card — filled by lcRenderAbsolute() (reacts to domain toggles)
    lcCheckCard(LC_CHECKS[2], data.checks.pdf.count, data.checks.pdf.examples),
    lcCheckCard(LC_CHECKS[3], data.checks.dam.count, data.checks.dam.examples),
    lcCheckCard(LC_CHECKS[4], data.checks.scene7.count, data.checks.scene7.examples),
  ].join('');

  const dc = document.getElementById('lcDomainCard');
  if (data.domains.length) {
    dc.style.display = '';
    document.getElementById('lcDomains').innerHTML = data.domains.map((d, i) => `
      <div class="form-check">
        <input class="form-check-input" type="checkbox" id="lcDom${i}" data-host="${escHtml(d.host)}" ${d.guessInternal ? '' : 'checked'} onchange="lcRenderAbsolute()" />
        <label class="form-check-label" for="lcDom${i}">
          <code>${escHtml(d.host)}</code>
          <span class="text-muted small">— ${d.count} link(s) on ${d.files} page(s)</span>
          ${d.guessInternal
            ? '<span class="badge bg-danger-subtle text-danger ms-1">internal?</span>'
            : '<span class="badge bg-secondary-subtle text-secondary ms-1">external?</span>'}
        </label>
      </div>`).join('') +
      `<div class="form-text mt-1">Checked = external (left as-is). Unchecked = internal (domain stripped, re-rooted to the site root).</div>`;
  } else dc.style.display = 'none';

  lcResetBroken();
  lcRenderAccessibility(data);
  lcRenderCrossLocale();
  lcRenderAbsolute();
  lcRenderUnresolvedAssets(data);
  document.getElementById('lcReport').style.display = '';
}

// Reset the on-demand Live URL check card whenever a fresh scan renders.
function lcResetBroken() {
  const card = document.getElementById('lcBrokenCard');
  card.style.display = '';
  card.style.borderLeftColor = '#6c757d';
  document.getElementById('lcBrokenCount').style.display = 'none';
  document.getElementById('lcBrokenBody').innerHTML = '<div class="text-muted small">Not run yet — classify absolute domains above, then click “Check links resolve”.</div>';
}

// On-demand live-URL (404) validation — respects the current internal/external domain choices.
async function lcValidateUrls() {
  if (!lcSessionId) { alert('Scan first.'); return; }
  const siteRoot = document.getElementById('lcSiteRoot').value.trim();
  const env  = document.getElementById('lcEnv').value;
  const btn  = document.getElementById('lcValidateBtn');
  const body = document.getElementById('lcBrokenBody');
  btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Checking…';
  body.innerHTML = '<div class="text-muted small"><span class="spinner-border spinner-border-sm me-2"></span>HEAD-checking link targets against AEM / DM…</div>';
  try {
    const res = await fetch('/api/link-checker/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: lcSessionId, siteRoot, env, internalDomains: lcInternalDomains() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Validation failed');
    lcRenderBroken(data);
  } catch (e) { body.innerHTML = `<div class="text-danger small">${escHtml(e.message)}</div>`; }
  finally { btn.disabled = false; btn.innerHTML = '<i class="bi bi-heart-pulse me-1"></i>Re-check'; }
}

// Status badge colour for a HEAD-check result.
function lcStatusBadge(s) {
  const cls = /^2\d\d/.test(s) ? 'bg-success'
    : /^3\d\d/.test(s) ? 'bg-info'
    : /^[45]\d\d/.test(s) ? 'bg-danger'
    : s.startsWith('ERR') ? 'bg-warning text-dark'
    : 'bg-secondary';
  return `<span class="badge ${cls} text-nowrap" style="min-width:3.2rem">${escHtml(s)}</span>`;
}

// Render the results of an on-demand /validate call — lists EVERY checked link.
function lcRenderBroken(data) {
  const card = document.getElementById('lcBrokenCard');
  const c = data.validatedCounts || { checked: 0, broken: 0, errors: 0, skipped: 0 };
  const links = data.links || [];
  const badCount = c.broken + c.errors;
  const badge = document.getElementById('lcBrokenCount');
  badge.style.display = ''; badge.textContent = badCount;
  badge.className = `badge ms-1 ${badCount ? 'bg-danger' : 'bg-success'}`;
  card.style.borderLeftColor = badCount ? '#dc3545' : '#198754';

  const aemNote = !data.hasAem
    ? '<div class="alert alert-warning py-2 small mb-2">No AEM host for the selected env — internal <code>/content</code> page &amp; asset paths can’t be reached, so only absolute DM URLs were checked. Pick an env with an AEM URL for a full check.</div>'
    : '';
  const summary = `<div class="small mb-2">HEAD-checked <strong>${c.checked}</strong> target(s): ` +
    `<strong class="${c.broken ? 'text-danger' : 'text-success'}">${c.broken} not found (404)</strong>, ` +
    `${c.errors} unreachable${c.skipped ? `, ${c.skipped} not checkable` : ''}.</div>`;

  const pageOf = p => p.replace(/\/(?:_?jcr_content\/.*|\.content\.xml)$/i, '') || p;
  const pageList = b => {
    const pages = (b.pages || []).map(pageOf);
    if (!pages.length) return '';
    const more = b.files > pages.length ? ` <span class="text-muted">+${b.files - pages.length} more</span>` : '';
    return `<div class="small text-muted ms-5 mb-1" style="margin-top:-2px">on: ` +
      pages.map(p => `<code class="text-secondary" style="word-break:break-all">${escHtml(p)}</code>`).join('<span class="mx-1">·</span>') + more + `</div>`;
  };
  const rows = links.length ? links.map(b => `
      <div class="d-flex align-items-center gap-2 pt-1 border-top">
        ${lcStatusBadge(b.headStatus)}
        <span class="badge bg-light text-dark border text-nowrap">${escHtml(b.check)}</span>
        <code class="small flex-grow-1" style="word-break:break-all">${escHtml(b.newUrl)}</code>
        <span class="text-muted small text-nowrap">${b.count}× · ${b.files} pg</span>
      </div>
      ${pageList(b)}`).join('')
    : '<div class="text-muted small">No checkable link targets found.</div>';

  document.getElementById('lcBrokenBody').innerHTML =
    aemNote + summary + `<div style="max-height:340px;overflow:auto">${rows}</div>`;
}

// Static accessibility findings (advisory — not auto-fixed).
const LC_A11Y_HINT = {
  'missing alt text': 'No <code>alt</code> — screen readers announce nothing. Add descriptive alt text.',
  'empty alt text': 'Empty <code>alt</code> — fine only for purely decorative images; otherwise describe it.',
  'control has no accessible label': 'Icon/link with no visible text or <code>aria-label</code> — add a label.',
  'missing caption': 'Figure has no <code>&lt;figcaption&gt;</code>.',
  'empty caption': 'Caption field is blank — a caption may have been lost in migration.',
  'vague link text': 'Link text like "read more" is meaningless out of context — make it descriptive.',
};
function lcRenderAccessibility(data) {
  const card = document.getElementById('lcA11yCard');
  const list = data.accessibility || [];
  if (!list.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  const total = list.reduce((s, a) => s + a.count, 0);
  document.getElementById('lcA11yCount').textContent = total;
  document.getElementById('lcA11yBody').innerHTML = list.map((a, i) => {
    const pageOf = p => p.replace(/\/(?:_?jcr_content|\.content\.xml).*$/i, '').replace(/\.content\.xml$/i, '');
    const samples = (a.samples || []).map(s => `
      <li class="mb-1">
        ${s.asset ? `<span class="fw-semibold">${escHtml(s.asset)}</span> — ` : ''}<code style="word-break:break-all">${escHtml(s.value || '(no value)')}</code>
        <div class="text-secondary" style="font-size:.75rem">${escHtml(pageOf(s.page))}</div>
      </li>`).join('');
    const more = a.count > (a.samples || []).length ? `<div class="form-text mb-0">…and ${a.count - a.samples.length} more occurrence(s).</div>` : '';
    return `
    <div class="mb-2 pb-2 border-bottom">
      <div class="d-flex align-items-center gap-2 flex-wrap">
        <span class="badge bg-info">${escHtml(a.issue)}</span>
        <code class="small">${escHtml(a.node)}</code>
        ${a.prop ? `<span class="text-muted small">· <code>${escHtml(a.prop)}</code></span>` : ''}
        <span class="text-muted small ms-auto">${a.count} occurrence(s) · ${a.files} page(s)</span>
      </div>
      ${LC_A11Y_HINT[a.issue] ? `<div class="small text-muted mt-1">${LC_A11Y_HINT[a.issue]}</div>` : ''}
      <ul class="small mt-2 mb-0" style="max-height:220px;overflow:auto">${samples}</ul>
      ${more}
    </div>`;
  }).join('');
}

// Assets the asset-map can't resolve — author pastes a DM URL for each; Fix all applies them.
function lcRenderUnresolvedAssets(data) {
  const card = document.getElementById('lcUnresolvedCard');
  const list = (data.unresolvedAssets || []);
  if (!list.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  document.getElementById('lcUnresolvedCount').textContent = list.length;
  document.getElementById('lcUnresolvedBody').innerHTML = list.map(a => `
    <div class="mb-3 pb-2 border-bottom">
      <div class="d-flex align-items-center gap-2 flex-wrap">
        <span class="badge bg-light text-dark border">${escHtml(a.check)}</span>
        <span class="badge bg-warning">${escHtml(a.verdict)}</span>
        <span class="text-muted small">${a.count} ref(s)</span>
      </div>
      <div class="small mt-1"><code style="word-break:break-all">${escHtml(a.current)}</code></div>
      <div class="d-flex align-items-center gap-2 mt-1">
        <i class="bi bi-arrow-return-right text-muted"></i>
        <input type="text" class="form-control form-control-sm lc-cmap" data-from="${escHtml(a.current)}" placeholder="paste the DM Open API URL" style="width:100%" />
      </div>
    </div>`).join('') +
    '<div class="form-text">Leave blank to skip. Filled rows are applied when you click Fix all (or any asset Fix).</div>';
}

// Author-supplied asset mappings from the Unresolved assets card → [{from, to}].
function lcCustomAssetMappings() {
  return [...document.querySelectorAll('#lcUnresolvedBody .lc-cmap')]
    .map(i => ({ from: i.dataset.from, to: i.value.trim() }))
    .filter(m => m.from && m.to);
}

// Cross-locale links, grouped by source locale. Each group: a checkbox, a count, the
// source root, and an editable target root (pre-filled with R). "Fix cross-locale"
// swaps each selected group's source prefix for its target. Unresolved links (no
// matching config locale) are listed read-only for manual handling.
function lcRenderCrossLocale() {
  const cc = document.getElementById('lcCrossCard');
  const cl = document.getElementById('lcCrossList');
  const xl = lcAnalysis && lcAnalysis.crossLocale;
  if (!xl || !xl.count) { cc.style.display = 'none'; return; }
  cc.style.display = '';
  document.getElementById('lcCrossCount').textContent = xl.count;
  const R = document.getElementById('lcSiteRoot').value.trim();
  const rm = R.match(/^(.*\/abbvie-com)\/(.+)$/);
  const localeSuffix = rm ? rm[2] : R.split('/').filter(Boolean).slice(-2).join('/');
  const exList = (arr, n) =>
    arr.slice(0, n).map(e => `<li><code>${escHtml(e.url)}</code> <span class="text-secondary">— ${escHtml(e.file)}</span></li>`).join('') +
    (arr.length > n ? `<li class="text-muted">… +${arr.length - n} more</li>` : '');

  // All cross-locale occurrences (config groups carry sourceRoot; unresolved are derived),
  // re-grouped by (source root, PAGE locale): the same link on a us/en page vs a
  // language-masters page needs a different target, so they become separate groups.
  const occ = [];
  for (const g of (xl.groups || [])) for (const e of (g.examples || [])) occ.push({ file: e.file, url: e.url, sourceRoot: g.sourceRoot });
  for (const e of ((xl.unresolved && xl.unresolved.examples) || [])) occ.push({ file: e.file, url: e.url, sourceRoot: lcLocaleRootOf(e.url, localeSuffix) });

  const gmap = new Map();   // key -> { sourceRoot, pageLocale, count, examples }
  const manual = [];
  for (const o of occ) {
    if (!o.sourceRoot) { manual.push(o); continue; }
    const pageLocale = lcLocaleRootOf(o.file, localeSuffix) || R;
    const key = o.sourceRoot + '||' + pageLocale;
    if (!gmap.has(key)) gmap.set(key, { sourceRoot: o.sourceRoot, pageLocale, count: 0, examples: [] });
    const g = gmap.get(key); g.count++; g.examples.push(o);
  }
  const groups = [...gmap.values()].sort((a, b) => b.count - a.count);

  let html = groups.map((g, i) => `
    <div class="lc-xloc-group border rounded p-2 mb-2" data-source="${escHtml(g.sourceRoot)}" data-page="${escHtml(g.pageLocale)}">
      <div class="d-flex align-items-center gap-2 flex-wrap">
        <input class="form-check-input mt-0 lc-xloc-check" type="checkbox" id="lcXloc${i}" checked />
        <label class="small mb-0" for="lcXloc${i}"><code class="fw-semibold">${escHtml(g.sourceRoot)}</code></label>
        <span class="badge bg-danger">${g.count}</span>
        <span class="badge bg-secondary-subtle text-secondary" title="page locale">on ${escHtml(g.pageLocale.split('/abbvie-com/')[1] || g.pageLocale)}</span>
        <span class="ms-1 small">→</span>
        <input type="text" class="form-control form-control-sm lc-xloc-target" style="max-width:520px"
          value="${escHtml(g.pageLocale)}" placeholder="target root" />
      </div>
      <ul class="small text-muted mt-2 mb-0" style="max-height:220px;overflow:auto">${exList(g.examples, g.examples.length)}</ul>
    </div>`).join('');

  if (manual.length) {
    html += `<div class="mt-3"><div class="small fw-semibold text-secondary">Couldn't auto-derive a source root — add a custom mapping below, or fix manually (${manual.length}):</div>
      <ul class="small text-muted mb-0" style="max-height:320px;overflow:auto">${exList(manual, manual.length)}</ul></div>`;
  }
  html += `<div class="mt-3 pt-2 border-top">
    <div class="small fw-semibold text-secondary mb-1">Custom mappings <span class="fw-normal">— any source root → target</span></div>
    <div id="lcXlocCustom"></div>
    <button class="btn btn-sm btn-outline-secondary mt-1" onclick="lcAddCustomXloc()"><i class="bi bi-plus me-1"></i>Add mapping</button>
  </div>`;
  html += `<div class="mt-3"><button class="btn btn-success btn-sm" onclick="lcFix(['crossLocale'])"><i class="bi bi-magic me-1"></i>Fix cross-locale &amp; download</button></div>`;
  cl.innerHTML = html;
}

// The locale-root portion of a /content path — R's own locale suffix OR any
// language-masters/<lang> segment. Returns the path up to and including the locale, or null.
function lcLocaleRootOf(path, localeSuffix) {
  const esc = localeSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re  = new RegExp('(\\/' + esc + '|\\/language-masters\\/[a-z][a-z0-9-]*)(?=\\/|$)', 'i');
  const mm  = path.match(re);
  return mm ? path.slice(0, mm.index + mm[1].length) : null;
}

// Add an empty custom source→target mapping row (target pre-filled with R).
function lcAddCustomXloc() {
  const box = document.getElementById('lcXlocCustom');
  const R = document.getElementById('lcSiteRoot').value.trim();
  const div = document.createElement('div');
  div.className = 'lc-xloc-custom d-flex align-items-center gap-2 mb-1';
  div.innerHTML = `
    <input type="text" class="form-control form-control-sm lc-xloc-cfrom" style="max-width:420px" placeholder="/content/abbvie-com2/us/en" />
    <span class="small">→</span>
    <input type="text" class="form-control form-control-sm lc-xloc-cto" style="max-width:420px" value="${escHtml(R)}" placeholder="target root" />
    <button class="btn btn-sm btn-outline-danger py-0 px-1" onclick="this.parentElement.remove()"><i class="bi bi-x"></i></button>`;
  box.appendChild(div);
}

// Selected groups + custom rows → [{from, to}] (blank from/to skipped).
function lcCrossLocaleMappings() {
  const groups = [...document.querySelectorAll('#lcCrossList .lc-xloc-group')]
    .filter(g => g.querySelector('.lc-xloc-check').checked)
    .map(g => ({ from: g.dataset.source, to: g.querySelector('.lc-xloc-target').value.trim(), page: g.dataset.page || '' }));
  const custom = [...document.querySelectorAll('#lcXlocCustom .lc-xloc-custom')]
    .map(r => ({ from: r.querySelector('.lc-xloc-cfrom').value.trim(), to: r.querySelector('.lc-xloc-cto').value.trim() }));
  return [...groups, ...custom].filter(m => m.from && m.to);
}

// internalDomains = the domains NOT ticked as external
function lcInternalDomains() {
  return [...document.querySelectorAll('#lcDomains input[type=checkbox]')]
    .filter(cb => !cb.checked).map(cb => cb.dataset.host);
}

// Re-render the Absolute URLs card to show only links on currently-internal domains
// (i.e. domains NOT ticked as external). Runs on load and on every domain toggle.
function lcRenderAbsolute() {
  const slot = document.getElementById('lcAbsSlot');
  if (!slot || !lcAnalysis) return;
  const internal = new Set(lcInternalDomains().map(h => h.toLowerCase()));
  const hostOf = u => { const m = u.match(/^https?:\/\/([^/]+)/i); return m ? m[1].toLowerCase() : ''; };
  const shown = (lcAnalysis.checks.absolute.examples || []).filter(e => internal.has(hostOf(e.url)));
  slot.innerHTML = lcCheckCard(LC_CHECKS[1], shown.length, shown);
}

// checks = array of check keys to fix, or null for all
async function lcFix(checks) {
  if (!lcSessionId) { alert('Scan first.'); return; }
  const siteRoot = document.getElementById('lcSiteRoot').value.trim();
  const env      = document.getElementById('lcEnv').value;
  const status   = document.getElementById('lcFixStatus');
  status.className = 'small mt-2 text-muted'; status.textContent = 'Fixing…';
  try {
    // checks === null → "Fix all": the 5 checks + image alt text, PLUS cross-locale when mappings are ready.
    const mappings = lcCrossLocaleMappings();
    let sel = checks;
    if (!sel) sel = mappings.length ? ['shortPath', 'absolute', 'pdf', 'dam', 'scene7', 'alt', 'crossLocale']
                                    : ['shortPath', 'absolute', 'pdf', 'dam', 'scene7', 'alt'];
    const body = { sessionId: lcSessionId, siteRoot, env, internalDomains: lcInternalDomains(), checks: sel };
    if (sel.includes('crossLocale')) body.crossLocaleMappings = mappings;
    if (sel.some(c => c === 'pdf' || c === 'dam' || c === 'scene7')) body.customAssetMappings = lcCustomAssetMappings();
    const res = await fetch('/api/link-checker/fix', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Fix failed'); }
    const pages = res.headers.get('X-Pages-Fixed');
    const changes = res.headers.get('X-Change-Count');
    const unmatched = res.headers.get('X-Unmatched');
    const reportId = res.headers.get('X-Report-Id');
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'qa-fixed-package.zip'; a.click();
    URL.revokeObjectURL(url);
    status.className = 'small mt-2 text-success';
    status.textContent = `✓ Fixed ${changes} reference(s) across ${pages} page(s)${unmatched > 0 ? `, ${unmatched} unmatched (no CSV entry)` : ''}. ZIP downloaded.`;
    if (reportId) {
      document.getElementById('lcDownloadRow').style.display = '';
      document.getElementById('lcReportLink').href = '/api/link-checker/fix-report/' + reportId;
    }
    // Re-scan to refresh counts — the session buffer now holds the fixed result.
    await lcScan();
  } catch (e) { status.className = 'small mt-2 text-danger'; status.textContent = e.message; }
}

// Auto-fill missing image alt text from each asset's DAM metadata dc:title.
async function lcFixAlt() {
  if (!lcSessionId) { alert('Scan first.'); return; }
  const siteRoot = document.getElementById('lcSiteRoot').value.trim();
  const env      = document.getElementById('lcEnv').value;
  const btn      = document.getElementById('lcFillAltBtn');
  const status   = document.getElementById('lcAltStatus');
  if (!env) { status.className = 'small w-100 mt-1 text-danger'; status.textContent = 'Select a target environment first — needed to read the DAM metadata.'; return; }
  btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Filling…';
  status.className = 'small w-100 mt-1 text-muted';
  status.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Reading dc:title from each asset’s metadata…';
  try {
    const res = await fetch('/api/link-checker/fix-alt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: lcSessionId, siteRoot, env }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Alt-text fix failed'); }
    const filled  = res.headers.get('X-Alt-Filled');
    const skipped = res.headers.get('X-Alt-Skipped');
    const pages   = res.headers.get('X-Pages-Fixed');
    const reportId = res.headers.get('X-Report-Id');
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'alt-fixed-package.zip'; a.click();
    URL.revokeObjectURL(url);
    status.className = 'small w-100 mt-1 text-success';
    status.innerHTML = `✓ Filled alt on <strong>${filled}</strong> image(s) across ${pages} page(s)` +
      (skipped > 0 ? `, ${skipped} skipped (see report)` : '') + `. ZIP downloaded.` +
      (reportId ? ` — <a href="/api/link-checker/fix-report/${reportId}">download report CSV</a>` : '');
    await lcScan();   // refresh — session now holds the alt-filled package
  } catch (e) { status.className = 'small w-100 mt-1 text-danger'; status.textContent = e.message; }
  finally { btn.disabled = false; btn.innerHTML = '<i class="bi bi-magic me-1"></i>Fill alt text'; }
}

// ─── Migration QA report (dry-run preview) ────────────────────────────────────
let lcReportData = null;
let lcReportFilterCls = 'all';

const LC_VERDICT = {
  fix:  { label: 'Will fix',        badge: 'bg-success'   },
  ok:   { label: 'Already ok',      badge: 'bg-secondary' },
  warn: { label: 'Needs attention', badge: 'bg-warning'   },
  cant: { label: "Can't fix",       badge: 'bg-danger'    },
  skip: { label: 'Skipped',         badge: 'bg-secondary' },
  a11y: { label: 'Accessibility',   badge: 'bg-info'      },
};

async function lcReport() {
  if (!lcFile) return;
  const siteRoot = document.getElementById('lcSiteRoot').value.trim();
  if (!siteRoot.startsWith('/content/')) { alert('Enter a valid site root starting with /content/'); return; }
  const env = document.getElementById('lcEnv').value;
  const btn = document.getElementById('lcReportBtn'); btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Reporting...';
  try {
    await lcEnsureSession();
    const validate = document.getElementById('lcValidate')?.checked || false;
    if (validate) btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Validating URLs...';
    const res  = await fetch('/api/link-checker/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: lcSessionId, siteRoot, env, validate }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Report failed');
    lcReportData = data;
    lcReportFilterCls = 'all';
    lcRenderReportPanel();
  } catch (e) { alert(e.message); }
  finally { btn.disabled = false; btn.innerHTML = '<i class="bi bi-file-earmark-text me-2"></i>Report'; }
}

function lcSetReportFilter(cls) { lcReportFilterCls = cls; lcRenderReportPanel(); }

function lcRenderReportPanel() {
  const d = lcReportData; if (!d) return;
  const s = d.summary;
  document.getElementById('lcReportPanel').style.display = '';

  const chip = (cls, label, n) =>
    `<button class="btn btn-sm ${lcReportFilterCls === cls ? 'btn-dark' : 'btn-outline-secondary'}" onclick="lcSetReportFilter('${cls}')">${label} <span class="badge ${cls === 'all' ? 'bg-secondary' : LC_VERDICT[cls].badge} ms-1">${n}</span></button>`;
  let chips = chip('all', 'All', (s.fix || 0) + (s.ok || 0) + (s.warn || 0) + (s.cant || 0) + (s.skip || 0) + (s.a11y || 0)) +
    ['fix', 'ok', 'warn', 'cant', 'skip', 'a11y'].map(c => chip(c, LC_VERDICT[c].label, s[c] || 0)).join('');
  if (d.validated) chips += chip('broken', 'Broken (404)', d.validatedCounts.broken + d.validatedCounts.errors);

  const isBroken = r => /^40[34]$/.test(r.headStatus) || (r.headStatus || '').startsWith('ERR');
  const rows = d.rows.filter(r =>
    lcReportFilterCls === 'all' ? true :
    lcReportFilterCls === 'broken' ? isBroken(r) :
    r.cls === lcReportFilterCls);

  const headBadge = r => {
    const st = r.headStatus;
    if (!st) return '';
    const cls = /^[23]\d\d$/.test(st) ? 'bg-success' : (/^40[34]/.test(st) ? 'bg-danger' : (st.startsWith('ERR') ? 'bg-warning' : 'bg-secondary'));
    return ` <span class="badge ${cls}" title="live URL check">${escHtml(st)}</span>`;
  };

  const rowHtml = rows.map(r => {
    const newLine = r.cls === 'a11y' ? ''
      : r.newUrl
        ? `<div class="small"><i class="bi bi-arrow-return-right text-muted me-1"></i><code class="text-success" style="word-break:break-all">${escHtml(r.newUrl)}</code></div>`
        : `<div class="small text-muted"><i class="bi bi-arrow-return-right me-1"></i>${r.cls === 'cant' ? "— can't fix —" : (r.cls === 'skip' ? 'unchanged' : '— review —')}</div>`;
    return `<div class="py-2 border-top">
      <div class="d-flex align-items-center gap-2 flex-wrap">
        <span class="badge bg-light text-dark border">${escHtml(r.check)}</span>
        <span class="badge ${LC_VERDICT[r.cls].badge}">${escHtml(r.verdict)}</span>${headBadge(r)}
        <span class="text-muted small ms-auto">${r.count} ref(s) · ${r.files} page(s)</span>
      </div>
      <div class="small mt-1"><code class="text-muted" style="word-break:break-all">${escHtml(r.current)}</code></div>
      ${newLine}
    </div>`;
  }).join('') || '<div class="text-muted small py-2">No references in this category.</div>';

  const valLine = d.validated
    ? ` <span class="text-secondary">Validated ${d.validatedCounts.checked} URL(s): <strong class="${d.validatedCounts.broken ? 'text-danger' : 'text-success'}">${d.validatedCounts.broken} broken (404)</strong>, ${d.validatedCounts.errors} error(s).</span>`
    : '';

  document.getElementById('lcReportBody').innerHTML =
    `<div class="text-muted small mb-2">Scanned <strong>${d.pagesScanned}</strong> Franklin page(s). Site root <code>${escHtml(d.siteRoot)}</code>.${d.env ? ` Env <strong>${escHtml(d.env)}</strong>${d.csvExists ? '' : ' <span class="text-danger">(no CSV — asset verdicts limited)</span>'}.` : ' <span class="text-warning">No env selected — asset verdicts limited.</span>'}${valLine}</div>
     <div class="d-flex gap-2 flex-wrap mb-3">${chips}</div>
     <div style="max-height:540px;overflow:auto">${rowHtml}</div>`;
}

function lcReportCsv() {
  if (!lcReportData) return;
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const header = ['check', 'verdict', 'current', 'new', 'head_status', 'refs', 'pages', 'sample_page'];
  const lines = [header.join(',')].concat(lcReportData.rows.map(r =>
    [r.check, r.verdict, r.current, r.newUrl, r.headStatus || '', r.count, r.files, (r.sample && r.sample[0]) || ''].map(esc).join(',')));
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'qa-report.csv'; a.click();
  URL.revokeObjectURL(url);
}

document.addEventListener('DOMContentLoaded', lcInit);
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
// LIGHTHOUSE AUDIT
// ══════════════════════════════════════════════════════════════════════════════

let lhResults     = [];
let lhActiveTier  = 'all';

function lhSyncThrottleHint() {
  const strategy = document.querySelector('input[name="lhStrategy"]:checked')?.value || 'mobile';
  const hint = document.getElementById('lhThrottleHint');
  if (!hint) return;
  hint.textContent = strategy === 'mobile'
    ? 'Auto → simulate: consistent scores, no CPU-contention between parallel tabs.'
    : 'Auto → devtools: matches Chrome DevTools Lighthouse panel exactly.';
}

function lhTier(score) {
  if (score === null || score === undefined) return 'error';
  if (score > 90)  return 'excellent';
  if (score >= 80) return 'good';
  if (score >= 60) return 'needs';
  return 'poor';
}

function lhScoreBadge(score) {
  if (score === null || score === undefined) return '<span class="badge bg-secondary">–</span>';
  const palette = {
    excellent: 'background:#198754;color:#fff',
    good:      'background:#ffc107;color:#212529',
    needs:     'background:#fd7e14;color:#fff',
    poor:      'background:#dc3545;color:#fff',
  };
  const style = palette[lhTier(score)] || '';
  return `<span class="badge" style="${style}">${score}</span>`;
}

function lhUpdateSummary(results) {
  const counts = { excellent: 0, good: 0, needs: 0, poor: 0 };
  for (const r of results) {
    const t = r.status === 'error' ? 'poor' : lhTier(r.scores?.performance);
    if (t in counts) counts[t]++;
  }
  document.getElementById('lhCountExcellent').textContent = counts.excellent;
  document.getElementById('lhCountGood').textContent      = counts.good;
  document.getElementById('lhCountNeeds').textContent     = counts.needs;
  document.getElementById('lhCountPoor').textContent      = counts.poor;
}

function lhRenderTable(results) {
  document.getElementById('lhTableBody').innerHTML = results.map(r => {
    if (r.status === 'error') {
      return `<tr data-tier="poor">
        <td class="font-monospace small" style="word-break:break-all">
          <a href="${escHtml(r.url)}" target="_blank" rel="noopener" class="text-decoration-none">${escHtml(r.url)}</a>
        </td>
        <td colspan="8" class="text-danger small"><i class="bi bi-exclamation-circle me-1"></i>${escHtml(r.error || 'Audit failed')}</td>
      </tr>`;
    }
    const s = r.scores  || {};
    const m = r.metrics || {};
    return `<tr data-tier="${lhTier(s.performance)}">
      <td class="font-monospace small" style="word-break:break-all">
        <a href="${escHtml(r.url)}" target="_blank" rel="noopener" class="text-decoration-none">${escHtml(r.url)}</a>
      </td>
      <td class="text-center">${lhScoreBadge(s.performance)}</td>
      <td class="text-center">${lhScoreBadge(s.seo)}</td>
      <td class="text-center">${lhScoreBadge(s.accessibility)}</td>
      <td class="text-center">${lhScoreBadge(s.bestPractices)}</td>
      <td class="text-center small text-muted">${escHtml(m.fcp)}</td>
      <td class="text-center small text-muted">${escHtml(m.lcp)}</td>
      <td class="text-center small text-muted">${escHtml(m.tbt)}</td>
      <td class="text-center small text-muted">${escHtml(m.cls)}</td>
    </tr>`;
  }).join('');

  filterLhTier(lhActiveTier);
}

function filterLhTier(tier) {
  lhActiveTier = tier;
  document.querySelectorAll('#lhTierFilter button').forEach(btn => {
    const active = btn.getAttribute('data-tier') === tier;
    const map = { all: ['btn-dark','btn-outline-dark'], excellent: ['btn-success','btn-outline-success'],
                  good: ['btn-warning','btn-outline-warning'], poor: ['btn-danger','btn-outline-danger'] };
    if (btn.getAttribute('data-tier') === 'needs') {
      btn.style.background  = active ? '#fd7e14' : '';
      btn.style.color       = active ? '#fff'    : '#fd7e14';
      btn.style.borderColor = '#fd7e14';
    } else {
      const [solid, outline] = map[btn.getAttribute('data-tier')] || ['btn-secondary','btn-outline-secondary'];
      btn.classList.toggle(solid,   active);
      btn.classList.toggle(outline, !active);
    }
  });
  lhApplyFilters();
}

function lhApplyFilters() {
  const q = (document.getElementById('lhSearch')?.value || '').toLowerCase();
  document.querySelectorAll('#lhTableBody tr').forEach(row => {
    const tierMatch = lhActiveTier === 'all' || row.getAttribute('data-tier') === lhActiveTier;
    const urlText   = row.querySelector('a')?.textContent.toLowerCase() || '';
    const textMatch = !q || urlText.includes(q);
    row.style.display = (tierMatch && textMatch) ? '' : 'none';
  });
}

async function runLighthouse() {
  const urlsRaw = document.getElementById('lhUrls').value.trim();
  const urls    = urlsRaw.split('\n').map(s => s.trim()).filter(Boolean);
  if (!urls.length) { alert('Enter at least one URL.'); return; }

  const strategy     = document.querySelector('input[name="lhStrategy"]:checked')?.value || 'mobile';
  const categories   = [...document.querySelectorAll('[id^="lhCat"]:checked')].map(el => el.value);
  if (!categories.length) { alert('Select at least one category.'); return; }

  const concurrency  = Math.max(1, Math.min(10, parseInt(document.getElementById('lhConcurrency')?.value, 10) || 3));
  const headless     = document.getElementById('lhHeadless')?.checked ?? false;
  const throttleSel  = document.getElementById('lhThrottling')?.value || 'auto';
  // auto: mobile → simulate (avoids CPU-contention variance under parallel load),
  //       desktop → devtools (matches Chrome DevTools panel exactly)
  const throttlingMethod = throttleSel === 'auto'
    ? (strategy === 'mobile' ? 'simulate' : 'devtools')
    : throttleSel;

  const btn = document.getElementById('lhRunBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Auditing…';

  lhResults    = [];
  lhActiveTier = 'all';
  hide('lhSummary');
  hide('lhResults');
  hide('lhEmpty');
  show('lhProgress');
  document.getElementById('lhProgressBar').style.width = '0%';
  document.getElementById('lhProgressText').textContent    = `0 / ${urls.length}`;
  document.getElementById('lhProgressCurrent').textContent = '';

  try {
    const { sessionId, error } = await fetchJSON('/api/lighthouse/start', {
      method: 'POST', body: { urls, strategy, categories, concurrency, headless, throttlingMethod },
    });
    if (error) throw new Error(error);

    await new Promise((resolve, reject) => {
      const es = new EventSource(`/api/lighthouse/progress/${sessionId}`);
      es.onmessage = ({ data }) => {
        try {
          const msg = JSON.parse(data);
          const done  = msg.done  ?? 0;
          const total = msg.total ?? urls.length;
          const pct   = total ? Math.round(done / total * 100) : 0;

          document.getElementById('lhProgressBar').style.width     = `${pct}%`;
          document.getElementById('lhProgressText').textContent    = `${done} / ${total}`;
          // Show the URL currently being audited (last result + 1)
          const next = msg.results?.[done]?.url ?? (done < urls.length ? urls[done] : '');
          document.getElementById('lhProgressCurrent').textContent = next ? `Auditing: ${next}` : '';

          if (msg.results?.length) {
            lhResults = msg.results;
            lhUpdateSummary(lhResults);
            lhRenderTable(lhResults);
            // .row needs display:flex (Bootstrap), not the block set by show()
            document.getElementById('lhSummary').style.display = '';
            document.getElementById('lhResults').style.display = 'flex';
          }
          if (msg.running === false) { es.close(); resolve(); }
        } catch { /* ignore parse errors */ }
      };
      es.onerror = () => { es.close(); reject(new Error('Connection to audit stream lost.')); };
    });
  } catch (err) {
    alert('Audit failed: ' + err.message);
  } finally {
    hide('lhProgress');
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-play-fill me-1"></i>Run Audit';
  }
}

function exportLhCsv() {
  if (!lhResults.length) return;
  const header = ['URL','Status','Performance','SEO','Accessibility','Best Practices','FCP','LCP','TBT','CLS','Tier'];
  const rows   = lhResults.map(r => {
    if (r.status === 'error') return [r.url, 'error', '', '', '', '', '', '', '', '', ''];
    const s = r.scores || {}, m = r.metrics || {};
    return [r.url, 'ok', s.performance ?? '', s.seo ?? '', s.accessibility ?? '', s.bestPractices ?? '',
            m.fcp, m.lcp, m.tbt, m.cls, lhTier(s.performance)];
  });
  const csv  = [header, ...rows].map(r => r.map(v => `"${String(v ?? '').replace(/"/g,'""')}"`).join(',')).join('\n');
  const a    = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
    download: 'lighthouse-report.csv',
  });
  a.click();
}

// ══════════════════════════════════════════════════════════════════════════════
// PROPERTY UPDATER TOOL
// ══════════════════════════════════════════════════════════════════════════════

let ppPages     = [];
let ppUpdateSSE = null;

function ppShowAlert(type, msg) {
  document.getElementById('ppAlert').innerHTML =
    `<div class="alert alert-${type} alert-dismissible py-2 mb-0">
      ${msg}
      <button type="button" class="btn-close btn-sm" data-bs-dismiss="alert"></button>
    </div>`;
}

const PP_NODE_DEFAULTS = { page: 'jcr:content', asset: 'jcr:content/metadata' };

function ppOnContentTypeChange() {
  const type = val('ppContentType') || 'page';
  const other = type === 'page' ? PP_NODE_DEFAULTS.asset : PP_NODE_DEFAULTS.page;
  const patternInput = document.getElementById('ppNodePattern');
  if (!patternInput.value.trim() || patternInput.value.trim() === other) {
    patternInput.value = PP_NODE_DEFAULTS[type];
  }
  document.getElementById('ppRootPath').placeholder = type === 'asset'
    ? '/content/dam/site/images'
    : '/content/site/us/en/about';
}

function ppDiscover() {
  const env = val('ppEnv');
  if (!env) return ppShowAlert('warning', 'Select a target environment.');
  const rootPath = val('ppRootPath');
  if (!rootPath) return ppShowAlert('warning', 'Root path is required.');

  const contentType  = val('ppContentType') || 'page';
  const nodePattern  = val('ppNodePattern') || PP_NODE_DEFAULTS[contentType];
  const propertyName = val('ppPropName');

  const btn = document.getElementById('ppDiscoverBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Discovering...';

  document.getElementById('ppDiscoverProgressWrap').style.display = 'block';
  document.getElementById('ppPagesCard').style.display = 'none';
  document.getElementById('ppAlert').innerHTML = '';
  setProgress('ppDiscoverProgress', 'ppDiscoverProgressLabel', 0, 1, 'Connecting...');

  const qs = new URLSearchParams({ env, rootPath, nodePattern, propertyName, contentType });
  const es = new EventSource(`/api/prop-updater/discover?${qs.toString()}`);

  const finish = () => {
    es.close();
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-search me-2"></i>Re-discover';
  };

  es.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'status') {
      document.getElementById('ppDiscoverProgressLabel').textContent = data.message;
    }
    if (data.type === 'total') {
      document.getElementById('ppDiscoverStats').textContent = `Found ${data.total} item(s)`;
    }
    if (data.type === 'progress') {
      setProgress('ppDiscoverProgress', 'ppDiscoverProgressLabel',
        data.done, data.total, `Checking ${data.done} / ${data.total} item(s)...`);
    }
    if (data.type === 'complete') {
      finish();
      document.getElementById('ppDiscoverStats').textContent =
        `${data.total} item(s) · ${data.nodeExistsCount} with "${nodePattern}"`;
      setProgress('ppDiscoverProgress', 'ppDiscoverProgressLabel', 1, 1, 'Discovery complete.');
      ppLoadPages();
    }
    if (data.type === 'error') {
      finish();
      ppShowAlert('danger', `Error: ${escHtml(data.message)}`);
    }
  };

  es.onerror = () => finish();
}

async function ppLoadPages() {
  const data = await fetchJSON('/api/prop-updater/pages');
  ppPages = data.pages || [];
  ppBuildPagesTable(ppPages);
}

function ppBuildPagesTable(pages) {
  const tbody = document.getElementById('ppPagesBody');
  tbody.innerHTML = '';
  document.getElementById('ppPagesCard').style.display = pages.length ? 'block' : 'none';

  const contentType = val('ppContentType') || 'page';
  const nodePattern = val('ppNodePattern') || PP_NODE_DEFAULTS[contentType];

  pages.forEach(page => {
    const currentDisplay = (page.currentValue === null || page.currentValue === undefined)
      ? '<span class="text-muted">—</span>'
      : escHtml(page.currentValue);
    tbody.insertAdjacentHTML('beforeend', `
      <tr data-path="${escHtml(page.path)}">
        <td><input type="checkbox" class="pp-page-chk" onchange="ppUpdateSelectionCount()" /></td>
        <td class="small font-monospace">${escHtml(page.path)}</td>
        <td class="small ${page.nodeExists ? 'text-success' : 'text-warning'}">${page.nodeExists ? escHtml(nodePattern) : 'missing'}</td>
        <td class="small">${currentDisplay}</td>
        <td><span class="pp-status-cell text-muted">—</span></td>
      </tr>`);
  });

  ppUpdateSelectionCount();
}

function ppFilterPagesTable() {
  const q = document.getElementById('ppPageFilter').value.trim().toLowerCase();
  document.querySelectorAll('#ppPagesBody tr').forEach(row => {
    row.style.display = (!q || row.getAttribute('data-path').toLowerCase().includes(q)) ? '' : 'none';
  });
}

function ppSelectAll() {
  document.querySelectorAll('.pp-page-chk').forEach(c => c.checked = true);
  document.getElementById('ppSelectAllChk').checked = true;
  ppUpdateSelectionCount();
}

function ppDeselectAll() {
  document.querySelectorAll('.pp-page-chk').forEach(c => c.checked = false);
  document.getElementById('ppSelectAllChk').checked = false;
  ppUpdateSelectionCount();
}

function ppSelectMissingOnly() {
  document.querySelectorAll('#ppPagesBody tr').forEach((row, i) => {
    row.querySelector('.pp-page-chk').checked = !ppPages[i]?.nodeExists;
  });
  document.getElementById('ppSelectAllChk').checked = false;
  ppUpdateSelectionCount();
}

function ppToggleAll(chk) {
  document.querySelectorAll('.pp-page-chk').forEach(c => c.checked = chk.checked);
  ppUpdateSelectionCount();
}

function ppUpdateSelectionCount() {
  const n = document.querySelectorAll('.pp-page-chk:checked').length;
  document.getElementById('ppSelectionCount').textContent = `${n} item${n !== 1 ? 's' : ''} selected`;
}

function ppGetSelectedPaths() {
  return [...document.querySelectorAll('#ppPagesBody tr')]
    .filter(r => r.querySelector('.pp-page-chk')?.checked)
    .map(r => r.getAttribute('data-path'));
}

async function ppRunUpdate() {
  const env = val('ppEnv');
  if (!env) return alert('Select a target environment.');
  const selected = ppGetSelectedPaths();
  if (!selected.length) return alert('Select at least one item.');

  const contentType = val('ppContentType') || 'page';
  const propertyName = val('ppPropName');
  if (!propertyName) return alert('Property name is required.');
  const propertyValue = val('ppPropValue');
  if (!propertyValue) return alert('Property value is required.');

  if (!confirm(`Set "${propertyName}" = "${propertyValue}" on ${selected.length} item(s)?`)) return;

  document.getElementById('ppUpdateProgressSection').style.display = 'block';
  document.getElementById('ppRunBtn').disabled = true;
  document.getElementById('ppUpdateLog').innerHTML = '';
  ppResetStats();

  if (ppUpdateSSE) ppUpdateSSE.close();
  ppUpdateSSE = new EventSource('/api/prop-updater/update/progress');
  ppUpdateSSE.onmessage = (e) => {
    const job = JSON.parse(e.data);
    ppRenderProgress(job);
    if (!job.running) {
      ppUpdateSSE.close();
      document.getElementById('ppRunBtn').disabled = false;
    }
  };

  const res = await fetchJSON('/api/prop-updater/update/start', {
    method: 'POST',
    body: {
      selectedPaths: selected,
      env,
      contentType,
      nodePattern:   val('ppNodePattern') || PP_NODE_DEFAULTS[contentType],
      propertyName,
      propertyValue,
      valueType:     val('ppPropType') || 'String',
    }
  });
  if (res.error) {
    ppShowAlert('danger', escHtml(res.error));
    document.getElementById('ppRunBtn').disabled = false;
    if (ppUpdateSSE) ppUpdateSSE.close();
  }
}

function ppRenderProgress(job) {
  document.getElementById('ppStatTotal').textContent  = job.total;
  document.getElementById('ppStatDone').textContent   = job.done - job.errors;
  document.getElementById('ppStatErrors').textContent = job.errors;

  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  const bar = document.getElementById('ppUpdateProgressBar');
  bar.style.width = pct + '%';
  bar.className = 'progress-bar' + (job.running ? ' progress-bar-striped progress-bar-animated' : '') +
    (job.errors > 0 && !job.running ? ' bg-warning' : '');
  document.getElementById('ppUpdateProgressLabel').textContent =
    job.running ? `Processing ${job.done} of ${job.total}...` : `Complete — ${job.total} items processed`;

  const tbody = document.getElementById('ppUpdateLog');
  const existingCount = tbody.querySelectorAll('tr').length;
  const newEntries = job.log.slice(existingCount);

  newEntries.forEach(entry => {
    const badgeClass = entry.status === 'success' ? 'bg-success' : 'bg-danger';
    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td class="small font-monospace">${escHtml(entry.pagePath)}</td>
        <td><span class="badge ${badgeClass}">${entry.status}</span></td>
        <td class="small text-muted">${escHtml(entry.message || '')}</td>
      </tr>`);
  });

  job.log.forEach(entry => {
    const row = document.querySelector(`#ppPagesBody tr[data-path="${CSS.escape(entry.pagePath)}"]`);
    if (row) {
      const cell = row.querySelector('.pp-status-cell');
      cell.className = `pp-status-cell ${entry.status === 'success' ? 'text-success' : 'text-danger'}`;
      cell.innerHTML = entry.status === 'success'
        ? '<i class="bi bi-check-circle-fill"></i>'
        : '<i class="bi bi-x-circle-fill"></i>';
    }
  });
}

function ppResetStats() {
  ['ppStatTotal', 'ppStatDone', 'ppStatErrors'].forEach(id => document.getElementById(id).textContent = '0');
  document.getElementById('ppUpdateProgressBar').style.width = '0%';
  document.getElementById('ppUpdateProgressLabel').textContent = '';
}

function ppExportLog() { window.location.href = '/api/prop-updater/export/log'; }

// ══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP
// ══════════════════════════════════════════════════════════════════════════════

window.addEventListener('DOMContentLoaded', () => {
  metaInit();
  imageInit();
  lcLoadSiteRoots();
  pkgInit();
});
