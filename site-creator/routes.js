'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// SITE CREATOR TOOL — server-side routes (/api/site-creator/*)
// All state is private to this module. Consumed by migration-tools/server.js:
//   require('./site-creator/routes')(app);
// Config files (environments.json, site-defaults.json, sites.json,
// aem-config-defaults.json, query-index-template.yaml) must be co-located in
// this directory. The encrypted token cache is written here as .auth-cache.json.
// ══════════════════════════════════════════════════════════════════════════════

const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const scCrypto  = require('crypto');
const yaml      = require('js-yaml');
const puppeteer = require('puppeteer-core');

module.exports = function registerSiteCreatorRoutes(app) {

  // ── Constants ───────────────────────────────────────────────────────────────
  const SC_ADMIN_BASE      = 'https://admin.hlx.page';
  const SC_AUTH_URL        = `${SC_ADMIN_BASE}/auth/adobe`;
  const SC_TOKEN_TTL_MS    = 6 * 60 * 60 * 1000;
  const SC_LOGIN_TIMEOUT_MS = 3 * 60 * 1000;
  const SC_AUTH_CACHE_FILE  = path.join(__dirname, '.auth-cache.json');
  const SC_SAFE_SEGMENT    = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

  // ── Mutable state ───────────────────────────────────────────────────────────
  let scTokenCache     = { token: null, expiresAt: 0 };
  let scLoginInProgress = false;
  const scAemCreds     = {};

  // ── Token helpers ───────────────────────────────────────────────────────────
  const scCachedToken = () =>
    (scTokenCache.token && Date.now() < scTokenCache.expiresAt ? scTokenCache.token : null);

  const scCacheKey = () =>
    scCrypto.scryptSync(`${os.hostname()}::${os.userInfo().username}::eds-site-creator`, 'eds-auth-cache-v1', 32);

  function scSaveAuthCache() {
    try {
      const iv     = scCrypto.randomBytes(12);
      const cipher = scCrypto.createCipheriv('aes-256-gcm', scCacheKey(), iv);
      const enc    = Buffer.concat([
        cipher.update(JSON.stringify({ tokenCache: scTokenCache, aemCreds: scAemCreds }), 'utf8'),
        cipher.final(),
      ]);
      const blob = {
        v: 1,
        iv:   iv.toString('base64'),
        tag:  cipher.getAuthTag().toString('base64'),
        data: enc.toString('base64'),
      };
      fs.writeFileSync(SC_AUTH_CACHE_FILE, JSON.stringify(blob), { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      console.warn('Could not persist auth cache:', err.message);
    }
  }

  function scLoadAuthCache() {
    if (!fs.existsSync(SC_AUTH_CACHE_FILE)) return;
    try {
      const { iv, tag, data } = JSON.parse(fs.readFileSync(SC_AUTH_CACHE_FILE, 'utf8'));
      const decipher = scCrypto.createDecipheriv('aes-256-gcm', scCacheKey(), Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      const obj = JSON.parse(
        Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')
      );
      if (obj.tokenCache?.token && Date.now() < obj.tokenCache.expiresAt) scTokenCache = obj.tokenCache;
      for (const [envId, c] of Object.entries(obj.aemCreds || {})) {
        if (c?.user && c?.pass) scAemCreds[envId] = { user: c.user, pass: c.pass };
      }
    } catch (err) {
      console.warn('Could not load auth cache (starting fresh):', err.message);
    }
  }

  async function scCaptureToken() {
    const launchOpts = {
      headless: false,
      defaultViewport: null,
      args: ['--no-first-run', '--no-default-browser-check'],
    };
    if (process.env.CHROME_PATH) launchOpts.executablePath = process.env.CHROME_PATH;
    else launchOpts.channel = 'chrome';

    const browser = await puppeteer.launch(launchOpts);
    try {
      const page = (await browser.pages())[0] || (await browser.newPage());
      await page.goto(SC_AUTH_URL, { waitUntil: 'domcontentloaded' });

      const deadline = Date.now() + SC_LOGIN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (browser.connected === false) throw new Error('Browser was closed before login completed.');
        let cookies = [];
        try { cookies = await browser.cookies(); } catch { cookies = await page.cookies(SC_ADMIN_BASE); }
        const c = cookies.find((x) => x.name === 'auth_token' && /hlx\.page$/.test(x.domain || ''));
        if (c && c.value) {
          scTokenCache = { token: c.value, expiresAt: Date.now() + SC_TOKEN_TTL_MS };
          scSaveAuthCache();
          return scTokenCache;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error('Timed out waiting for sign-in (3 minutes).');
    } finally {
      await browser.close().catch(() => {});
    }
  }

  // ── Config file helpers ─────────────────────────────────────────────────────
  const scReadJson  = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
  const scReadText  = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
  const scLoadDefaults    = () => scReadJson('site-defaults.json');
  const scLoadEnvironments = () => scReadJson('environments.json').environments;
  const scLoadSites        = () => scReadJson('sites.json').sites;
  const scLoadIndexTemplate = () => scReadText('query-index-template.yaml');
  const scLoadAemConfigDefaults = () => scReadJson('aem-config-defaults.json');

  // ── AEM credential helpers ──────────────────────────────────────────────────
  const scEnvById  = (id)   => scLoadEnvironments().find((e) => e.id === id);
  const scBasicAuth = (cred) => `Basic ${Buffer.from(`${cred.user}:${cred.pass}`).toString('base64')}`;
  const scGetAemCred = (envId) => scAemCreds[envId] || null;

  // ── Payload resolvers ───────────────────────────────────────────────────────
  function scResolve(envId, base) {
    const d    = scLoadDefaults();
    const env  = scLoadEnvironments().find((e) => e.id === envId);
    const site = scLoadSites().find((s) => s.base === base);
    if (!env)  throw new Error(`Unknown environment: ${envId}`);
    if (!site) throw new Error(`Unknown site: ${base}`);

    const fullSite   = `${env.sitePrefix}-${site.base}`;
    const contentUrl = d.contentSourcePattern
      .replace('{authorHost}', env.authorHost)
      .replace('{org}', d.org)
      .replace('{site}', fullSite)
      .replace('{branch}', env.branch);

    const cp = site.contentPath.replace(/\/+$/, '');
    const configAdmin = env.configAdmin || d.access.admin.role.config_admin;
    const payload = {
      code: d.code,
      content: { source: { url: contentUrl, type: d.content.type, suffix: d.content.suffix } },
      access: {
        admin: {
          role: { config_admin: configAdmin, admin: d.access.admin.role.admin },
          requireAuth: d.access.admin.requireAuth,
        },
      },
      sidekick: d.sidekick,
      public: { paths: { mappings: [`${cp}/:/`], includes: [`${cp}/`, d.damInclude] } },
    };

    const hasPlaceholder = (v) => (Array.isArray(v) ? v : [v]).some((x) => /^REPLACE-/.test(String(x)));

    return {
      org: d.org,
      fullSite,
      branch: env.branch,
      payload,
      liveUrl: `https://${env.branch}--${fullSite}--${d.org}.aem.page`,
      configCheckUrl: `https://${env.branch}--${fullSite}--${d.org}.aem.page/config.json`,
      hostPlaceholder: hasPlaceholder(env.authorHost),
      configPlaceholder: hasPlaceholder(configAdmin),
    };
  }

  function scResolveIndex(envId, base) {
    const d    = scLoadDefaults();
    const env  = scLoadEnvironments().find((e) => e.id === envId);
    const site = scLoadSites().find((s) => s.base === base);
    if (!env)  throw new Error(`Unknown environment: ${envId}`);
    if (!site) throw new Error(`Unknown site: ${base}`);

    const fullSite  = `${env.sitePrefix}-${site.base}`;
    const indexName = `${site.country} ${site.language}`.trim();
    const target    = `/query-index-${site.lang}.json`;
    const body      = scLoadIndexTemplate()
      .replaceAll('{indexName}', indexName)
      .replaceAll('{target}', target);

    return {
      fullSite,
      indexName,
      target,
      yaml: body,
      requestUrl: `${SC_ADMIN_BASE}/config/${encodeURIComponent(d.org)}/sites/${encodeURIComponent(fullSite)}/content/query.yaml`,
    };
  }

  function scResolveAemConfig(envId, base) {
    const d    = scLoadAemConfigDefaults();
    const env  = scLoadEnvironments().find((e) => e.id === envId);
    const site = scLoadSites().find((s) => s.base === base);
    if (!env)  throw new Error(`Unknown environment: ${envId}`);
    if (!site) throw new Error(`Unknown site: ${base}`);

    const fullSite      = `${env.sitePrefix}-${site.base}`;
    const confRoot      = d.confRoot;
    const configNodePath = `${confRoot}/${fullSite}/settings/cloudconfigs/${d.configNodeName}`;

    const subtree = {
      'jcr:primaryType': 'sling:Folder',
      'jcr:title': fullSite,
      'sling:resourceType': 'sling:Folder',
      settings: {
        'jcr:primaryType': 'sling:Folder',
        'sling:resourceType': 'sling:Folder',
        cloudconfigs: {
          'jcr:primaryType': 'sling:Folder',
          [d.configNodeName]: {
            'jcr:primaryType': 'cq:Page',
            'jcr:content': {
              'jcr:primaryType': 'cq:PageContent',
              'jcr:mixinTypes': ['mix:versionable'],
              'jcr:title': d.title,
              'cq:template': d.template,
              'sling:resourceType': d.resourceType,
              'sling:configPropertyInherit': d.slingConfigPropertyInherit,
              auxiliaryScripts: d.auxiliaryScripts,
              edgeHost:    env.aemEdgeHost   || d.edgeHost,
              owner:       env.aemOwner      || d.owner,
              projectType: env.aemProjectType || d.projectType,
              ref:         env.aemRef        || d.ref,
              repo:        fullSite,
            },
          },
        },
        dam: {
          'jcr:primaryType': 'cq:Page',
          cfm: {
            'jcr:primaryType': 'cq:Page',
            models: {
              'jcr:primaryType': 'cq:Page',
              'jcr:content': { 'jcr:primaryType': 'nt:unstructured' },
            },
          },
        },
        graphql: {
          'jcr:primaryType': 'cq:Page',
          persistentQueries: {
            'jcr:primaryType': 'cq:Page',
            'jcr:content': { 'jcr:primaryType': 'nt:unstructured' },
          },
        },
        wcm: {
          'jcr:primaryType': 'cq:Page',
          segments: {
            'jcr:primaryType': 'cq:Page',
            'jcr:content': {
              'jcr:primaryType': 'cq:PageContent',
              'sling:resourceType': 'cq/contexthub/components/segments-listing-page',
            },
          },
          templates:        { 'jcr:primaryType': 'cq:Page' },
          policies:         { 'jcr:primaryType': 'cq:Page' },
          'template-types': {
            'jcr:primaryType': 'cq:Page',
            'jcr:content': { 'jcr:primaryType': 'cq:PageContent', mergeList: true },
          },
        },
      },
    };

    const cqConf      = `${confRoot}/${fullSite}`;
    const contentRoot = site.contentPath.replace(/\/+$/, '');
    return {
      fullSite, confRoot,
      configNodeName: d.configNodeName,
      configNodePath,
      siteNodePath:  `${confRoot}/${fullSite}`,
      authorHost:    env.authorHost,
      importUrl:     `https://${env.authorHost}${confRoot}`,
      siteNodeUrl:   `https://${env.authorHost}${confRoot}/${encodeURIComponent(fullSite)}.json`,
      subtree,
      cqConf, contentRoot,
      contentRootUrl: `https://${env.authorHost}${contentRoot}.json`,
      applyUrl:       `https://${env.authorHost}${contentRoot}/jcr:content`,
    };
  }

  async function scApplyCqConf(r, auth) {
    const check = await fetch(`${r.applyUrl}.json`, { headers: { authorization: auth } });
    if (!check.ok) {
      return { ok: false, status: check.status, error: `root page jcr:content not found (HTTP ${check.status})` };
    }
    const form = new URLSearchParams();
    form.set('cq:conf', r.cqConf);
    const ap = await fetch(r.applyUrl, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
    });
    return { ok: ap.ok, status: ap.status, statusText: ap.statusText, cqConf: r.cqConf };
  }

  function scJcrContentToForm(jc) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(jc || {})) {
      if (k === 'jcr:primaryType' || k === 'jcr:mixinTypes') continue;
      if (Array.isArray(v)) {
        v.forEach((x) => form.append(k, String(x)));
        form.set(`${k}@TypeHint`, 'String[]');
      } else if (typeof v === 'boolean') {
        form.set(k, String(v));
        form.set(`${k}@TypeHint`, 'Boolean');
      } else {
        form.set(k, String(v));
      }
    }
    return form;
  }

  // ── Routes ──────────────────────────────────────────────────────────────────

  app.post('/api/site-creator/login', async (req, res) => {
    if (scCachedToken()) return res.json({ ok: true, cached: true, expiresAt: scTokenCache.expiresAt });
    if (scLoginInProgress) return res.status(409).json({ ok: false, error: 'Sign-in already in progress.' });
    scLoginInProgress = true;
    try {
      const t = await scCaptureToken();
      res.json({ ok: true, expiresAt: t.expiresAt });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    } finally {
      scLoginInProgress = false;
    }
  });

  app.get('/api/site-creator/token-status', (req, res) => {
    res.json({ hasToken: !!scCachedToken(), expiresAt: scCachedToken() ? scTokenCache.expiresAt : 0, loginInProgress: scLoginInProgress });
  });

  app.post('/api/site-creator/logout', (req, res) => {
    scTokenCache = { token: null, expiresAt: 0 };
    scSaveAuthCache();
    res.json({ ok: true });
  });

  app.get('/api/site-creator/token', (req, res) => {
    const t = scCachedToken();
    if (!t) return res.status(401).json({ ok: false, error: 'Not signed in.' });
    res.json({ ok: true, token: t, expiresAt: scTokenCache.expiresAt });
  });

  app.post('/api/site-creator/aem-credentials', (req, res) => {
    const { envId, user, pass } = req.body || {};
    if (!scEnvById(envId)) return res.status(400).json({ ok: false, error: 'Unknown environment.' });
    if (!user || !pass)   return res.status(400).json({ ok: false, error: 'Username and password are required.' });
    scAemCreds[envId] = { user, pass };
    scSaveAuthCache();
    res.json({ ok: true });
  });

  app.get('/api/site-creator/aem-credentials-status', (req, res) => {
    const status = {};
    scLoadEnvironments().forEach((e) => {
      const c = scGetAemCred(e.id);
      status[e.id] = { hasCreds: !!c, user: c?.user || null };
    });
    res.json(status);
  });

  app.post('/api/site-creator/aem-credentials/clear', (req, res) => {
    delete scAemCreds[(req.body || {}).envId];
    scSaveAuthCache();
    res.json({ ok: true });
  });

  app.post('/api/site-creator/preview-aem-config', (req, res) => {
    try {
      const { envId, base } = req.body || {};
      res.json(scResolveAemConfig(envId, base));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/site-creator/create-aem-config', async (req, res) => {
    const { envId, base, subtree: subtreeOverride } = req.body || {};
    const mode = (req.body || {}).mode === 'update' ? 'update' : 'create';
    const env  = scEnvById(envId);
    const cred = scGetAemCred(envId);
    if (!env)  return res.status(400).json({ ok: false, error: 'Unknown environment.' });
    if (!cred) return res.status(401).json({ ok: false, error: `No AEM credentials for "${envId}".` });

    let r;
    try { r = scResolveAemConfig(envId, base); }
    catch (err) { return res.status(400).json({ ok: false, error: err.message }); }

    let subtree = r.subtree;
    if (subtreeOverride !== undefined) {
      if (typeof subtreeOverride !== 'object' || subtreeOverride === null || Array.isArray(subtreeOverride)) {
        return res.status(400).json({ ok: false, error: 'Edited AEM config must be a JSON object.', site: r.fullSite });
      }
      subtree = subtreeOverride;
    }

    const auth          = scBasicAuth(cred);
    const jcrContentUrl = `https://${r.authorHost}${r.configNodePath}/jcr:content`;
    const configCheckUrl = `https://${r.authorHost}${r.configNodePath}.json`;

    try {
      if (mode === 'update') {
        const check = await fetch(configCheckUrl, { headers: { authorization: auth } });
        if (!check.ok) {
          const msg = (check.status === 401 || check.status === 403)
            ? `Authentication failed (HTTP ${check.status}) — check the credentials for this environment.`
            : `Config node not found (HTTP ${check.status}) — use Create mode first.`;
          return res.json({ ok: false, status: check.status, site: r.fullSite, configNodePath: r.configNodePath, error: msg });
        }
        const jc = subtree?.settings?.cloudconfigs?.[r.configNodeName]?.['jcr:content'];
        if (!jc) return res.status(400).json({ ok: false, error: 'Could not locate jcr:content in the AEM config.', site: r.fullSite });

        const upd = await fetch(jcrContentUrl, {
          method: 'POST',
          headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: scJcrContentToForm(jc).toString(),
        });
        const text = await upd.text();
        let body; try { body = JSON.parse(text); } catch { body = text; }
        const apply = upd.ok ? await scApplyCqConf(r, auth) : null;
        return res.json({ ok: upd.ok, action: 'updated', status: upd.status, statusText: upd.statusText,
          site: r.fullSite, configNodePath: r.configNodePath, cqConf: r.cqConf, apply, response: body });
      }

      const check = await fetch(r.siteNodeUrl, { headers: { authorization: auth } });
      if (check.ok) {
        const apply = await scApplyCqConf(r, auth);
        return res.json({ ok: true, action: 'skipped', skipped: true, status: check.status, site: r.fullSite,
          configNodePath: r.configNodePath, cqConf: r.cqConf, apply, message: 'already exists — skipped' });
      }

      const form = new URLSearchParams();
      form.set(':operation', 'import');
      form.set(':contentType', 'json');
      form.set(':name', r.fullSite);
      form.set(':replace', 'false');
      form.set(':replaceProperties', 'true');
      form.set(':content', JSON.stringify(subtree));

      const imp = await fetch(r.importUrl, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
      });
      const text = await imp.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      const apply = imp.ok ? await scApplyCqConf(r, auth) : null;
      return res.json({ ok: imp.ok, action: 'created', status: imp.status, statusText: imp.statusText,
        site: r.fullSite, configNodePath: r.configNodePath, cqConf: r.cqConf, apply, response: body });
    } catch (err) {
      return res.status(502).json({ ok: false, error: `Failed to reach ${env.authorHost}: ${err.message}`, site: r.fullSite });
    }
  });

  app.post('/api/site-creator/aem-test', async (req, res) => {
    const { envId } = req.body || {};
    const env  = scEnvById(envId);
    const cred = scGetAemCred(envId);
    if (!env)        return res.status(400).json({ ok: false, error: 'Unknown environment.' });
    if (cred == null) return res.status(401).json({ ok: false, error: 'No credentials set for this environment.' });

    const url = `https://${env.authorHost}/libs/granite/security/currentuser.json`;
    try {
      const r = await fetch(url, { headers: { authorization: scBasicAuth(cred) } });
      const text = await r.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      res.json({ ok: r.ok, status: r.status, statusText: r.statusText, authorId: body?.authorizableId || body?.userID || null });
    } catch (err) {
      res.status(502).json({ ok: false, error: `Failed to reach ${env.authorHost}: ${err.message}` });
    }
  });

  app.get('/api/site-creator/config', (req, res) => {
    res.json({
      org: scLoadDefaults().org,
      environments: scLoadEnvironments().map((e) => ({
        id: e.id, label: e.label, sitePrefix: e.sitePrefix, authorHost: e.authorHost, branch: e.branch,
        needsHost:   /^REPLACE-/.test(e.authorHost),
        needsConfig: (e.configAdmin || []).some((x) => /^REPLACE-/.test(String(x))),
      })),
      sites: scLoadSites(),
    });
  });

  app.post('/api/site-creator/preview', (req, res) => {
    try {
      const { envId, base } = req.body || {};
      const r = scResolve(envId, base);
      r.requestUrl = `${SC_ADMIN_BASE}/config/${encodeURIComponent(r.org)}/sites/${encodeURIComponent(r.fullSite)}.json`;
      res.json(r);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/site-creator/preview-index', (req, res) => {
    try {
      const { envId, base } = req.body || {};
      res.json(scResolveIndex(envId, base));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/site-creator/validate-yaml', (req, res) => {
    const { yaml: text } = req.body || {};
    try {
      yaml.load(String(text ?? ''));
      res.json({ ok: true });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  app.post('/api/site-creator/create-index', async (req, res) => {
    const { envId, base, method = 'POST', yaml: yamlOverride } = req.body || {};
    const token = (req.body || {}).token || scCachedToken();
    if (!token) return res.status(401).json({ ok: false, error: 'Not signed in — click Sign in first.' });

    let r;
    try { r = scResolveIndex(envId, base); }
    catch (err) { return res.status(400).json({ ok: false, error: err.message }); }

    let body = r.yaml;
    if (yamlOverride !== undefined) {
      if (typeof yamlOverride !== 'string') {
        return res.status(400).json({ ok: false, error: 'Edited YAML must be a string.', site: r.fullSite });
      }
      try { yaml.load(yamlOverride); }
      catch (err) { return res.status(400).json({ ok: false, error: `Invalid YAML: ${err.message}`, site: r.fullSite }); }
      body = yamlOverride;
    }

    const httpMethod = ['POST', 'PUT'].includes(String(method).toUpperCase()) ? String(method).toUpperCase() : 'POST';
    try {
      const adminRes = await fetch(r.requestUrl, {
        method: httpMethod,
        headers: { 'content-type': 'text/yaml', 'x-auth-token': token },
        body,
      });
      const text = await adminRes.text();
      let payload; try { payload = JSON.parse(text); } catch { payload = text; }
      return res.status(200).json({ ok: adminRes.ok, status: adminRes.status, statusText: adminRes.statusText,
        site: r.fullSite, requestUrl: r.requestUrl, response: payload });
    } catch (err) {
      return res.status(502).json({ ok: false, error: `Failed to reach admin API: ${err.message}`, site: r.fullSite });
    }
  });

  app.post('/api/site-creator/create-site', async (req, res) => {
    const { envId, base, method = 'POST', payload } = req.body || {};
    const token = (req.body || {}).token || scCachedToken();
    if (!token) return res.status(401).json({ ok: false, error: 'Not signed in — click Sign in first.' });

    let r;
    try { r = scResolve(envId, base); }
    catch (err) { return res.status(400).json({ ok: false, error: err.message }); }

    if (r.hostPlaceholder) {
      return res.status(400).json({ ok: false,
        error: `Environment "${envId}" still has a placeholder author host. Set it in environments.json.` });
    }
    if (!SC_SAFE_SEGMENT.test(r.org) || !SC_SAFE_SEGMENT.test(r.fullSite)) {
      return res.status(400).json({ ok: false, error: 'Invalid org or site name.' });
    }

    let bodyPayload = r.payload;
    if (payload !== undefined) {
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        return res.status(400).json({ ok: false, error: 'Edited payload must be a JSON object.', site: r.fullSite });
      }
      bodyPayload = payload;
    } else if (r.configPlaceholder) {
      return res.status(400).json({ ok: false,
        error: `Environment "${envId}" still has a placeholder config_admin. Set it in environments.json.`,
        site: r.fullSite });
    }

    const httpMethod = ['POST', 'PUT'].includes(String(method).toUpperCase()) ? String(method).toUpperCase() : 'POST';
    const url = `${SC_ADMIN_BASE}/config/${encodeURIComponent(r.org)}/sites/${encodeURIComponent(r.fullSite)}.json`;
    try {
      const adminRes = await fetch(url, {
        method: httpMethod,
        headers: { 'content-type': 'application/json', 'x-auth-token': token },
        body: JSON.stringify(bodyPayload),
      });
      const text = await adminRes.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      return res.status(200).json({ ok: adminRes.ok, status: adminRes.status, statusText: adminRes.statusText,
        site: r.fullSite, requestUrl: url, response: body,
        liveUrl: adminRes.ok ? r.liveUrl : null, configCheckUrl: r.configCheckUrl });
    } catch (err) {
      return res.status(502).json({ ok: false, error: `Failed to reach admin API: ${err.message}`, site: r.fullSite });
    }
  });

  // Restore token + AEM creds from previous server run
  scLoadAuthCache();
};
