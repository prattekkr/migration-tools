// ══ SITE CREATOR TOOL ════════════════════════════════════════════════════════
// All state and helpers are private to this IIFE. No globals are added.
// The IIFE patches window.switchTool to include the sitecreator panel so
// that migration-tools/public/app.js needs zero modifications.
// ═════════════════════════════════════════════════════════════════════════════
(function scTool() {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const READY_STATUS = 'in sync with master';
  const CONCURRENCY = 4;

  let CONFIG = { org: 'abbvie', environments: [], sites: [] };
  let rowState = {};
  let overrides = {};
  let indexOverrides = {};
  let aemOverrides = {};
  let modalKey = null;
  let modalTab = 'json';
  let hasToken = false;
  let tokenExpiresAt = 0;
  let aemStatus = {};

  const ovKey = (envId, base) => `${envId}::${base}`;

  function escapeHtml(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  const isReady = (s) => (s.status || '').trim().toLowerCase() === READY_STATUS;
  const currentEnv = () => CONFIG.environments.find((e) => e.id === $('sc-env').value);
  const fullName = (base) => `${currentEnv()?.sitePrefix}-${base}`;

  async function init() {
    CONFIG = await (await fetch('/api/site-creator/config')).json();

    $('sc-env').innerHTML = CONFIG.environments
      .map((e) => `<option value="${e.id}">${escapeHtml(e.label)}</option>`)
      .join('');
    $('sc-env').addEventListener('change', onEnvChange);

    buildTable();
    onEnvChange();

    $('sc-search').addEventListener('input', applyFilter);
    $('sc-check-all').addEventListener('change', (e) => {
      visibleSiteRows().forEach((tr) => {
        const cb = tr.querySelector('.row-check');
        cb.checked = e.target.checked;
        rowState[cb.dataset.base].checked = e.target.checked;
      });
      syncAllRegionChecks();
      updateCount();
    });
    document.querySelectorAll('#tool-sitecreator [data-sel]').forEach((b) =>
      b.addEventListener('click', () => bulkSelect(b.dataset.sel)));
    $('sc-create').addEventListener('click', createSelected);

    $('sc-login').addEventListener('click', doLogin);
    $('sc-logout').addEventListener('click', doLogout);
    $('sc-view-token').addEventListener('click', toggleToken);
    $('sc-copy-token').addEventListener('click', copyToken);
    $('sc-aem-save').addEventListener('click', saveAemCreds);
    $('sc-aem-test').addEventListener('click', testAemCreds);
    $('sc-aem-clear').addEventListener('click', clearAemCreds);
    refreshTokenStatus();
    refreshAemStatus();
    setInterval(renderTokenStatus, 30000);

    $('sc-modal-close').addEventListener('click', closeModal);
    $('sc-modal-validate').addEventListener('click', validateModal);
    $('sc-modal-save').addEventListener('click', saveModal);
    $('sc-modal-reset').addEventListener('click', resetModal);
    document.querySelectorAll('#sc-modal .modal-tabs .tab').forEach((t) =>
      t.addEventListener('click', () => switchTab(t.dataset.tab)));
    $('sc-modal').addEventListener('click', (e) => { if (e.target.id === 'sc-modal') closeModal(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('sc-modal') && !$('sc-modal').classList.contains('sc-hidden')) closeModal();
    });
  }

  // ── authentication ────────────────────────────────────────────────────────
  function renderTokenStatus() {
    const el = $('sc-token-status');
    if (!el) return;
    if (hasToken && Date.now() < tokenExpiresAt) {
      const mins = Math.max(0, Math.round((tokenExpiresAt - Date.now()) / 60000));
      const h = Math.floor(mins / 60), m = mins % 60;
      el.className = 'sc-token-status ok';
      el.textContent = `✓ Signed in — token valid for ${h}h ${m}m`;
      $('sc-logout').classList.remove('sc-hidden');
      $('sc-view-token').classList.remove('sc-hidden');
    } else {
      hasToken = false;
      el.className = 'sc-token-status';
      el.textContent = 'Not signed in.';
      $('sc-logout').classList.add('sc-hidden');
      $('sc-view-token').classList.add('sc-hidden');
      hideToken();
    }
    updateCount();
  }

  function hideToken() {
    $('sc-token-reveal').classList.add('sc-hidden');
    $('sc-token-value').value = '';
    $('sc-view-token').textContent = 'View token';
  }

  async function toggleToken() {
    if (!$('sc-token-reveal').classList.contains('sc-hidden')) { hideToken(); return; }
    try {
      const r = await (await fetch('/api/site-creator/token')).json();
      if (!r.ok) {
        $('sc-token-status').className = 'sc-token-status err';
        $('sc-token-status').textContent = `✗ ${r.error}`;
        return;
      }
      $('sc-token-value').value = r.token;
      $('sc-token-reveal').classList.remove('sc-hidden');
      $('sc-view-token').textContent = 'Hide token';
    } catch (err) {
      $('sc-token-status').className = 'sc-token-status err';
      $('sc-token-status').textContent = `✗ ${err.message}`;
    }
  }

  async function copyToken() {
    const val = $('sc-token-value').value;
    if (!val) return;
    const btn = $('sc-copy-token');
    try {
      await navigator.clipboard.writeText(val);
      btn.textContent = 'Copied!';
    } catch {
      $('sc-token-value').select();
      document.execCommand('copy');
      btn.textContent = 'Copied!';
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  }

  async function refreshTokenStatus() {
    try {
      const s = await (await fetch('/api/site-creator/token-status')).json();
      hasToken = s.hasToken;
      tokenExpiresAt = s.expiresAt || 0;
    } catch {
      hasToken = false;
    }
    renderTokenStatus();
  }

  async function doLogin() {
    const btn = $('sc-login');
    btn.disabled = true;
    btn.innerHTML = '<span class="sc-spinner"></span>Opening Chrome…';
    $('sc-token-status').className = 'sc-token-status';
    $('sc-token-status').textContent = 'Complete the Adobe sign-in in the Chrome window that just opened…';
    try {
      const r = await (await fetch('/api/site-creator/login', { method: 'POST' })).json();
      if (r.ok) {
        hasToken = true;
        tokenExpiresAt = r.expiresAt;
      } else {
        $('sc-token-status').className = 'sc-token-status err';
        $('sc-token-status').textContent = `✗ ${r.error || 'Sign-in failed.'}`;
      }
    } catch (err) {
      $('sc-token-status').className = 'sc-token-status err';
      $('sc-token-status').textContent = `✗ ${err.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in to admin.hlx.page';
      renderTokenStatus();
    }
  }

  async function doLogout() {
    await fetch('/api/site-creator/logout', { method: 'POST' }).catch(() => {});
    hasToken = false;
    tokenExpiresAt = 0;
    renderTokenStatus();
  }

  // ── AEM per-environment credentials ──────────────────────────────────────
  async function refreshAemStatus() {
    try { aemStatus = await (await fetch('/api/site-creator/aem-credentials-status')).json(); }
    catch { aemStatus = {}; }
    updateAemCard();
  }

  function updateAemCard() {
    const env = currentEnv();
    if (!env) return;
    $('sc-aem-env-label').textContent = env.label;
    $('sc-aem-host').textContent = env.authorHost;
    const st = aemStatus[env.id] || { hasCreds: false };
    const msg = $('sc-aem-status');
    if (st.hasCreds) {
      msg.className = 'sc-token-status ok';
      msg.textContent = `✓ Credentials saved for ${env.label}${st.user ? ` (${st.user})` : ''}.`;
      $('sc-aem-clear').classList.remove('sc-hidden');
    } else {
      msg.className = 'sc-token-status';
      msg.textContent = `No credentials saved for ${env.label}.`;
      $('sc-aem-clear').classList.add('sc-hidden');
    }
    $('sc-aem-user').value = '';
    $('sc-aem-pass').value = '';
  }

  async function saveAemCreds() {
    const env = currentEnv();
    const user = $('sc-aem-user').value.trim();
    const pass = $('sc-aem-pass').value;
    if (!user || !pass) { setAemMsg('Enter username and password.', 'err'); return; }
    try {
      const r = await (await fetch('/api/site-creator/aem-credentials', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envId: env.id, user, pass }),
      })).json();
      if (r.ok) { $('sc-aem-pass').value = ''; await refreshAemStatus(); }
      else setAemMsg(`✗ ${r.error}`, 'err');
    } catch (err) { setAemMsg(`✗ ${err.message}`, 'err'); }
  }

  async function testAemCreds() {
    const env = currentEnv();
    const btn = $('sc-aem-test');
    btn.disabled = true; const prev = btn.textContent;
    btn.innerHTML = '<span class="sc-spinner-sm"></span>Testing…';
    try {
      const r = await (await fetch('/api/site-creator/aem-test', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envId: env.id }),
      })).json();
      if (r.ok) setAemMsg(`✓ Connected to ${env.authorHost} as ${r.authorId || 'user'} (HTTP ${r.status}).`, 'ok');
      else setAemMsg(`✗ ${r.error || `HTTP ${r.status} ${r.statusText || ''}`}`, 'err');
    } catch (err) { setAemMsg(`✗ ${err.message}`, 'err'); }
    finally { btn.disabled = false; btn.textContent = prev; }
  }

  async function clearAemCreds() {
    const env = currentEnv();
    await fetch('/api/site-creator/aem-credentials/clear', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envId: env.id }),
    }).catch(() => {});
    await refreshAemStatus();
  }

  function setAemMsg(text, cls) {
    $('sc-aem-status').className = `sc-token-status ${cls || ''}`;
    $('sc-aem-status').textContent = text;
  }

  const STEPS = [
    { key: 'site',  label: 'Site',           abbr: 'S' },
    { key: 'index', label: 'Query index',    abbr: 'Q' },
    { key: 'aem',   label: 'AEM config',     abbr: 'C' },
    { key: 'apply', label: 'Apply to root',  abbr: 'R' },
  ];
  const REGION_ORDER = ['Americas', 'LATAM', 'Europe', 'Middle East', 'APAC'];
  const getSite = (base) => CONFIG.sites.find((s) => s.base === base);

  function pillsHtml() {
    return `<span class="pills">${STEPS.map((st) =>
      `<span class="pill idle" data-step="${st.key}" title="${st.label}: not run">${st.abbr}</span>`).join('')}</span>`;
  }

  function buildTable() {
    const body = $('sc-sites-body');
    body.innerHTML = '';
    rowState = {};

    const byRegion = {};
    CONFIG.sites.forEach((s) => { (byRegion[s.region] ||= []).push(s); });
    const regions = [
      ...REGION_ORDER.filter((r) => byRegion[r]),
      ...Object.keys(byRegion).filter((r) => !REGION_ORDER.includes(r)),
    ];

    regions.forEach((region) => {
      const sites = byRegion[region];
      const hr = document.createElement('tr');
      hr.className = 'region-row';
      hr.dataset.region = region;
      hr.innerHTML = `
        <td class="c-check"><input type="checkbox" class="sc-region-check" title="Select all in ${escapeHtml(region)}" /></td>
        <td colspan="5">
          <button type="button" class="sc-region-caret" aria-label="Collapse">▾</button>
          <span class="sc-region-name">${escapeHtml(region)}</span>
          <span class="sc-region-count">${sites.length}</span>
        </td>`;
      body.appendChild(hr);
      hr.querySelector('.sc-region-caret').addEventListener('click', () => toggleRegion(region));
      hr.querySelector('.sc-region-check').addEventListener('change', (e) => regionSelect(region, e.target.checked));

      sites.forEach((s) => {
        rowState[s.base] = { checked: false, steps: {}, region, liveUrl: null };
        const tr = document.createElement('tr');
        tr.className = 'site-row';
        tr.dataset.base = s.base;
        tr.dataset.region = region;
        tr.dataset.search = `${s.country} ${s.folder} ${s.lang} ${s.language} ${s.contentPath} ${region}`.toLowerCase();
        tr.innerHTML = `
          <td class="c-check"><input type="checkbox" class="row-check" data-base="${escapeHtml(s.base)}" /></td>
          <td><button type="button" class="sc-expand-caret" aria-label="Details">▸</button><span class="sc-mono sc-site-name"></span></td>
          <td>${escapeHtml(s.country)} <span class="sc-muted-text">/${escapeHtml(s.folder)}</span></td>
          <td class="sc-mono">${escapeHtml(s.lang)}</td>
          <td class="c-json"><button type="button" class="sc-json-btn sc-ghost" data-base="${escapeHtml(s.base)}">{ }</button></td>
          <td class="c-pipe">${pillsHtml()}</td>`;
        body.appendChild(tr);

        const dr = document.createElement('tr');
        dr.className = 'detail-row sc-hidden';
        dr.dataset.region = region;
        dr.innerHTML = `<td></td><td colspan="5"><div class="detail-panel"></div></td>`;
        body.appendChild(dr);

        const cb = tr.querySelector('.row-check');
        cb.addEventListener('change', () => {
          rowState[s.base].checked = cb.checked;
          syncRegionCheck(region);
          updateCount();
        });
        tr.querySelector('.sc-json-btn').addEventListener('click', () => openModal(s.base));
        tr.querySelector('.sc-expand-caret').addEventListener('click', () => toggleDetail(s.base));
        tr.querySelector('.sc-site-name').addEventListener('click', () => toggleDetail(s.base));
        rowState[s.base].tr = tr;
        rowState[s.base].detailTr = dr;
      });
    });
  }

  // ── region grouping ───────────────────────────────────────────────────────
  function toggleRegion(region) {
    const body = $('sc-sites-body');
    const hr = body.querySelector(`.region-row[data-region="${CSS.escape(region)}"]`);
    const collapsed = hr.classList.toggle('collapsed');
    hr.querySelector('.sc-region-caret').textContent = collapsed ? '▸' : '▾';
    body.querySelectorAll(`tr.site-row[data-region="${CSS.escape(region)}"], tr.detail-row[data-region="${CSS.escape(region)}"]`)
      .forEach((tr) => { tr.classList.toggle('region-hidden', collapsed); });
    if (collapsed) {
      body.querySelectorAll(`tr.detail-row[data-region="${CSS.escape(region)}"]`)
        .forEach((dr) => dr.classList.add('sc-hidden'));
    }
  }

  function regionSelect(region, checked) {
    CONFIG.sites.filter((s) => s.region === region).forEach((s) => {
      const cb = rowState[s.base].tr.querySelector('.row-check');
      if (rowState[s.base].tr.classList.contains('filtered-out')) return;
      cb.checked = checked;
      rowState[s.base].checked = checked;
    });
    updateCount();
  }

  function syncRegionCheck(region) {
    const sites = CONFIG.sites.filter((s) => s.region === region);
    const checked = sites.filter((s) => rowState[s.base].checked).length;
    const hr = $('sc-sites-body').querySelector(`.region-row[data-region="${CSS.escape(region)}"]`);
    const box = hr?.querySelector('.sc-region-check');
    if (!box) return;
    box.checked = checked === sites.length && sites.length > 0;
    box.indeterminate = checked > 0 && checked < sites.length;
  }
  function syncAllRegionChecks() {
    [...new Set(CONFIG.sites.map((s) => s.region))].forEach(syncRegionCheck);
  }

  // ── pipeline pills ────────────────────────────────────────────────────────
  function setStep(base, key, state, detail = {}) {
    const rs = rowState[base];
    rs.steps[key] = { state, ...detail };
    const pill = rs.tr.querySelector(`.pill[data-step="${key}"]`);
    if (pill) {
      pill.className = `pill ${state}`;
      const st = STEPS.find((s) => s.key === key);
      pill.title = `${st.label}: ${detail.title || state}`;
    }
    if (!rs.detailTr.classList.contains('sc-hidden')) renderDetail(base);
  }

  function resetPills(base, { alsoIndex, alsoAem }) {
    rowState[base].steps = {};
    rowState[base].liveUrl = null;
    setStep(base, 'site', 'idle', { title: 'queued' });
    setStep(base, 'index', alsoIndex ? 'idle' : 'na', { title: alsoIndex ? 'queued' : 'not requested' });
    setStep(base, 'aem',   alsoAem  ? 'idle' : 'na', { title: alsoAem  ? 'queued' : 'not requested' });
    setStep(base, 'apply', alsoAem  ? 'idle' : 'na', { title: alsoAem  ? 'queued' : 'not requested' });
  }

  // ── expandable row detail ─────────────────────────────────────────────────
  async function toggleDetail(base) {
    const rs = rowState[base];
    const caret = rs.tr.querySelector('.sc-expand-caret');
    const opening = rs.detailTr.classList.contains('sc-hidden');
    rs.detailTr.classList.toggle('sc-hidden', !opening);
    caret.textContent = opening ? '▾' : '▸';
    caret.classList.toggle('open', opening);
    if (opening) {
      renderDetail(base);
      if (!rs.previews) await loadPreviews(base);
    }
  }

  async function loadPreviews(base) {
    const envId = $('sc-env').value;
    const post = (u, b) => fetch(u, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
    }).then((r) => r.json());
    try {
      const [site_, idx, aem] = await Promise.all([
        post('/api/site-creator/preview', { envId, base }),
        post('/api/site-creator/preview-index', { envId, base }),
        post('/api/site-creator/preview-aem-config', { envId, base }),
      ]);
      rowState[base].previews = { site: site_, idx, aem };
    } catch {
      rowState[base].previews = null;
    }
    if (!rowState[base].detailTr.classList.contains('sc-hidden')) renderDetail(base);
  }

  function stepResultRow(base, key) {
    const st = rowState[base].steps[key];
    const meta = STEPS.find((s) => s.key === key);
    if (!st || st.state === 'na') return '';
    const icon = { idle: '•', run: '…', ok: '✓', fail: '✗', skip: '⊘' }[st.state] || '•';
    const extra = st.error ? ` — ${escapeHtml(st.error)}` : (st.title ? ` — ${escapeHtml(st.title)}` : '');
    return `<div class="dr-step ${st.state}"><b>${icon} ${meta.label}</b>${extra}</div>`;
  }

  function renderDetail(base) {
    const rs = rowState[base];
    const s = getSite(base);
    const p = rs.previews;
    const ran = Object.values(rs.steps).some((x) => x && x.state && !['idle', 'na'].includes(x.state));
    const pre = (obj) => `<pre>${escapeHtml(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2))}</pre>`;

    const results = ran ? `<div class="dr-block"><h4>Run results</h4>
      ${STEPS.map((st) => stepResultRow(base, st.key)).join('')}
      ${rs.liveUrl ? `<div class="dr-step"><a href="${rs.liveUrl}" target="_blank" rel="noopener">Open live URL ↗</a></div>` : ''}
    </div>` : '';

    const facts = `<div class="dr-facts">
      <div><span>Site</span><code>${escapeHtml(fullName(base))}</code></div>
      <div><span>Country</span>${escapeHtml(s.country)} · ${escapeHtml(s.language)} (${escapeHtml(s.lang)})</div>
      <div><span>Content path</span><code>${escapeHtml(s.contentPath)}</code></div>
      ${p?.aem ? `<div><span>cq:conf</span><code>${escapeHtml(p.aem.cqConf || '')}</code></div>` : ''}
    </div>`;

    const configs = p ? `
      <details class="dr-details"><summary>Site config (JSON)</summary>${pre(p.site.payload)}</details>
      <details class="dr-details"><summary>Query index (YAML)</summary>${pre(p.idx.yaml)}</details>
      <details class="dr-details"><summary>AEM cloud config (JSON)</summary>${pre(p.aem.subtree)}</details>`
      : '<div class="dr-loading">Loading config…</div>';

    rs.detailTr.querySelector('.detail-panel').innerHTML = `${facts}${results}<div class="dr-block"><h4>Resolved config</h4>${configs}</div>`;
  }

  function markEdited(base) {
    const btn = rowState[base].tr.querySelector('.sc-json-btn');
    const key = ovKey($('sc-env').value, base);
    const edited = !!overrides[key] || !!indexOverrides[key] || !!aemOverrides[key];
    btn.classList.toggle('edited', edited);
    btn.textContent = edited ? '{ }•' : '{ }';
    btn.title = edited ? 'Edited config — click to review' : 'View / edit config';
  }
  function refreshEditedMarks() {
    CONFIG.sites.forEach((s) => markEdited(s.base));
  }

  function onEnvChange() {
    const env = currentEnv();
    CONFIG.sites.forEach((s) => {
      const rs = rowState[s.base];
      rs.tr.querySelector('.sc-site-name').textContent = fullName(s.base);
      rs.steps = {}; rs.liveUrl = null; rs.previews = null;
      rs.detailTr.classList.add('sc-hidden');
      rs.tr.querySelector('.sc-expand-caret').textContent = '▸';
      rs.tr.querySelectorAll('.pill').forEach((pill) => {
        pill.className = 'pill idle';
        pill.title = `${STEPS.find((x) => x.abbr === pill.textContent).label}: not run`;
      });
    });
    const info = $('sc-env-info');
    const warnings = [];
    if (env.needsHost)   warnings.push(`author host (currently <code>${escapeHtml(env.authorHost)}</code>)`);
    if (env.needsConfig) warnings.push('config_admin (technical account)');
    if (warnings.length) {
      info.className = 'sc-env-info err';
      info.innerHTML = `⚠ Not set for <b>${escapeHtml(env.label)}</b>: ${warnings.join(' and ')} — edit <code>environments.json</code>.`;
    } else {
      info.className = 'sc-env-info';
      info.innerHTML = `Author host: <code>${escapeHtml(env.authorHost)}</code> · branch <code>${escapeHtml(env.branch)}</code>`;
    }
    refreshEditedMarks();
    updateAemCard();
    updateCount();
  }

  // ── modal ─────────────────────────────────────────────────────────────────
  function clearMsg() {
    $('sc-modal-msg').textContent = '';
    $('sc-modal-msg').className = 'sc-modal-msg';
  }

  async function openModal(base) {
    const envId = $('sc-env').value;
    modalKey = ovKey(envId, base);
    const site = CONFIG.sites.find((s) => s.base === base);
    $('sc-modal-title').textContent = `${fullName(base)} — ${site.country} (${site.lang})`;
    clearMsg();

    const post = (url, body) => fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then((r) => r.json());

    let site_, idx, aem;
    try {
      [site_, idx, aem] = await Promise.all([
        post('/api/site-creator/preview', { envId, base }),
        post('/api/site-creator/preview-index', { envId, base }),
        post('/api/site-creator/preview-aem-config', { envId, base }),
      ]);
    } catch {
      site_ = { requestUrl: '(preview unavailable)', payload: {} };
      idx   = { requestUrl: '(preview unavailable)', yaml: '' };
      aem   = { importUrl: '(preview unavailable)', subtree: {} };
    }

    const m = $('sc-modal');
    m.dataset.defaultPayload = JSON.stringify(site_.payload, null, 2);
    m.dataset.defaultYaml    = idx.yaml || '';
    m.dataset.defaultAem     = JSON.stringify(aem.subtree, null, 2);
    m.dataset.urlJson = site_.requestUrl || '';
    m.dataset.urlYaml = idx.requestUrl  || '';
    m.dataset.urlAem  = `${aem.importUrl || ''}  →  ${aem.configNodePath || ''}`;

    $('sc-modal-json').value = overrides[modalKey] ? JSON.stringify(overrides[modalKey], null, 2) : m.dataset.defaultPayload;
    $('sc-modal-yaml').value = indexOverrides[modalKey] ?? m.dataset.defaultYaml;
    $('sc-modal-aem').value  = aemOverrides[modalKey]  ? JSON.stringify(aemOverrides[modalKey], null, 2) : m.dataset.defaultAem;

    switchTab('json');
    m.classList.remove('sc-hidden');
  }

  function switchTab(tab) {
    modalTab = tab;
    clearMsg();
    document.querySelectorAll('#sc-modal .modal-tabs .tab').forEach((t) =>
      t.classList.toggle('active', t.dataset.tab === tab));
    $('sc-modal-json').classList.toggle('sc-hidden', tab !== 'json');
    $('sc-modal-yaml').classList.toggle('sc-hidden', tab !== 'yaml');
    $('sc-modal-aem').classList.toggle('sc-hidden',  tab !== 'aem');
    const m = $('sc-modal');
    $('sc-modal-url').textContent = tab === 'json' ? m.dataset.urlJson : tab === 'yaml' ? m.dataset.urlYaml : m.dataset.urlAem;
    $('sc-modal-method').textContent = 'POST';
    $(`sc-modal-${tab}`).focus();
  }

  function closeModal() { $('sc-modal').classList.add('sc-hidden'); modalKey = null; }

  async function validateModal() {
    const msg = $('sc-modal-msg');
    if (modalTab === 'json' || modalTab === 'aem') {
      try {
        const parsed = JSON.parse($(`sc-modal-${modalTab}`).value);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
          throw new Error('Top level must be a JSON object.');
        msg.textContent = '✓ Valid JSON object.'; msg.className = 'sc-modal-msg ok';
        return true;
      } catch (err) {
        msg.textContent = `✗ ${err.message}`; msg.className = 'sc-modal-msg err';
        return false;
      }
    }
    try {
      const r = await fetch('/api/site-creator/validate-yaml', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ yaml: $('sc-modal-yaml').value }),
      }).then((x) => x.json());
      if (r.ok) { msg.textContent = '✓ Valid YAML.'; msg.className = 'sc-modal-msg ok'; return true; }
      msg.textContent = `✗ ${r.error}`; msg.className = 'sc-modal-msg err';
      return false;
    } catch (err) {
      msg.textContent = `✗ ${err.message}`; msg.className = 'sc-modal-msg err';
      return false;
    }
  }

  async function saveModal() {
    const m = $('sc-modal');
    const base = modalKey.split('::')[1];

    let parsed;
    try {
      parsed = JSON.parse($('sc-modal-json').value);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error('Top level must be a JSON object.');
    } catch (err) {
      switchTab('json');
      $('sc-modal-msg').textContent = `✗ Site config: ${err.message}`;
      $('sc-modal-msg').className = 'sc-modal-msg err';
      return;
    }
    const yamlText = $('sc-modal-yaml').value;
    const yv = await fetch('/api/site-creator/validate-yaml', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yaml: yamlText }),
    }).then((x) => x.json()).catch(() => ({ ok: false, error: 'validation failed' }));
    if (!yv.ok) {
      switchTab('yaml');
      $('sc-modal-msg').textContent = `✗ Query index: ${yv.error}`;
      $('sc-modal-msg').className = 'sc-modal-msg err';
      return;
    }
    let aemParsed;
    try {
      aemParsed = JSON.parse($('sc-modal-aem').value);
      if (typeof aemParsed !== 'object' || aemParsed === null || Array.isArray(aemParsed))
        throw new Error('Top level must be a JSON object.');
    } catch (err) {
      switchTab('aem');
      $('sc-modal-msg').textContent = `✗ AEM config: ${err.message}`;
      $('sc-modal-msg').className = 'sc-modal-msg err';
      return;
    }

    if (JSON.stringify(parsed, null, 2) === m.dataset.defaultPayload) delete overrides[modalKey];
    else overrides[modalKey] = parsed;
    if (yamlText === m.dataset.defaultYaml) delete indexOverrides[modalKey];
    else indexOverrides[modalKey] = yamlText;
    if (JSON.stringify(aemParsed, null, 2) === m.dataset.defaultAem) delete aemOverrides[modalKey];
    else aemOverrides[modalKey] = aemParsed;

    markEdited(base);
    closeModal();
  }

  function resetModal() {
    const m = $('sc-modal');
    const val = { json: m.dataset.defaultPayload, yaml: m.dataset.defaultYaml, aem: m.dataset.defaultAem }[modalTab];
    $(`sc-modal-${modalTab}`).value = val;
    $('sc-modal-msg').textContent = 'Reset to default (not yet saved).';
    $('sc-modal-msg').className = 'sc-modal-msg';
  }

  function visibleSiteRows() {
    return [...$('sc-sites-body').querySelectorAll('tr.site-row')].filter((tr) => !tr.classList.contains('filtered-out'));
  }

  function applyFilter() {
    const q = $('sc-search').value.trim().toLowerCase();
    $('sc-sites-body').querySelectorAll('tr.site-row').forEach((tr) => {
      const hide = q && !tr.dataset.search.includes(q);
      tr.classList.toggle('filtered-out', hide);
      if (hide) rowState[tr.dataset.base].detailTr.classList.add('sc-hidden');
      rowState[tr.dataset.base].detailTr.classList.toggle('filtered-out', hide);
    });
    $('sc-sites-body').querySelectorAll('tr.region-row').forEach((hr) => {
      const region = hr.dataset.region;
      const any = CONFIG.sites.some((s) => s.region === region && !rowState[s.base].tr.classList.contains('filtered-out'));
      hr.classList.toggle('filtered-out', !any);
    });
  }

  function bulkSelect(kind) {
    visibleSiteRows().forEach((tr) => {
      const cb = tr.querySelector('.row-check');
      const s = getSite(cb.dataset.base);
      const val = kind === 'all' ? true : kind === 'none' ? false : isReady(s);
      cb.checked = val;
      rowState[cb.dataset.base].checked = val;
    });
    syncAllRegionChecks();
    updateCount();
  }

  function selectedBases() {
    return Object.entries(rowState).filter(([, v]) => v.checked).map(([b]) => b);
  }

  function updateCount() {
    const n = selectedBases().length;
    const btn = $('sc-create');
    if (!btn) return;
    btn.textContent = `Create selected (${n})`;
    const env = currentEnv();
    btn.disabled = n === 0 || !hasToken || env?.needsHost || env?.needsConfig;
  }

  const errText = (d) => d.error || `${d.status || ''} ${d.statusText || ''}`.trim();

  async function createSelected() {
    if (!hasToken) { $('sc-progress').textContent = 'Sign in first.'; return; }

    const env   = currentEnv();
    const bases = selectedBases();
    if (!bases.length) return;

    const alsoIndex = $('sc-also-index').checked;
    const alsoAem   = $('sc-also-aem').checked;
    const aemMode   = $('sc-aem-mode').value;
    if (alsoAem && !(aemStatus[env.id] && aemStatus[env.id].hasCreds)) {
      $('sc-progress').textContent = `Save AEM credentials for ${env.label} first (or uncheck "AEM cloud config").`;
      return;
    }

    $('sc-create').disabled = true;
    $('sc-search').value = '';
    applyFilter();
    bases.forEach((b) => resetPills(b, { alsoIndex, alsoAem }));

    let done = 0, ok = 0, fail = 0;
    const prog = $('sc-progress');
    const update = () => { prog.textContent = `Processing ${done}/${bases.length} — ${ok} ok, ${fail} failed`; };
    update();

    const post = (url, body) => fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then((r) => r.json());

    const queue = [...bases];
    async function worker() {
      while (queue.length) {
        const base = queue.shift();
        const key  = ovKey(env.id, base);
        let rowOk  = true;

        setStep(base, 'site', 'run', { title: 'creating…' });
        let siteData;
        try {
          const override = overrides[key];
          siteData = await post('/api/site-creator/create-site', { envId: env.id, base, ...(override ? { payload: override } : {}) });
        } catch (err) { siteData = { ok: false, error: err.message }; }

        if (!siteData.ok) {
          setStep(base, 'site', 'fail', { title: errText(siteData), error: errText(siteData) });
          fail += 1; done += 1; update();
          continue;
        }
        rowState[base].liveUrl = siteData.liveUrl;
        setStep(base, 'site', 'ok', { title: `HTTP ${siteData.status}` });

        if (alsoIndex) {
          setStep(base, 'index', 'run', { title: 'creating…' });
          let idxData;
          try {
            const yamlOverride = indexOverrides[key];
            idxData = await post('/api/site-creator/create-index', {
              envId: env.id, base,
              ...(yamlOverride !== undefined ? { yaml: yamlOverride } : {}),
            });
          } catch (err) { idxData = { ok: false, error: err.message }; }
          if (idxData.ok) setStep(base, 'index', 'ok', { title: `HTTP ${idxData.status}` });
          else { setStep(base, 'index', 'fail', { title: errText(idxData), error: errText(idxData) }); rowOk = false; }
        }

        if (alsoAem) {
          setStep(base, 'aem', 'run', { title: `${aemMode}…` });
          let aemData;
          try {
            const aemOverride = aemOverrides[key];
            aemData = await post('/api/site-creator/create-aem-config', {
              envId: env.id, base, mode: aemMode,
              ...(aemOverride ? { subtree: aemOverride } : {}),
            });
          } catch (err) { aemData = { ok: false, error: err.message }; }

          if (aemData.ok && aemData.action === 'skipped')
            setStep(base, 'aem', 'skip', { title: 'already exists' });
          else if (aemData.ok)
            setStep(base, 'aem', 'ok', { title: `${aemData.action || 'done'} HTTP ${aemData.status}` });
          else {
            setStep(base, 'aem', 'fail', { title: errText(aemData), error: errText(aemData) });
            rowOk = false;
          }

          if (aemData.apply) {
            if (aemData.apply.ok) setStep(base, 'apply', 'ok', { title: `HTTP ${aemData.apply.status}` });
            else {
              setStep(base, 'apply', 'fail', { title: errText(aemData.apply), error: errText(aemData.apply) });
              rowOk = false;
            }
          } else if (!aemData.ok) {
            setStep(base, 'apply', 'na', { title: 'skipped (config failed)' });
          }
        }

        rowOk ? (ok += 1) : (fail += 1);
        done += 1; update();
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, bases.length) }, worker));
    prog.textContent = `Done — ${ok} ok, ${fail} failed (of ${bases.length}).`;
    $('sc-create').disabled = false;
  }

  // ── switchTool patch ──────────────────────────────────────────────────────
  // Wraps the existing window.switchTool so the sitecreator panel shows/hides
  // correctly. Runs after main app.js because this script is loaded with defer.
  const _origSwitch = window.switchTool;
  window.switchTool = function (name) {
    _origSwitch(name);
    const panel = document.getElementById('tool-sitecreator');
    const btn   = document.getElementById('tool-btn-sitecreator');
    if (panel) panel.style.display = name === 'sitecreator' ? 'block' : 'none';
    if (btn)   btn.classList.toggle('active', name === 'sitecreator');
  };

  // ── boot ──────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => { init(); });

})();
