'use strict';
// Runs a single Lighthouse audit in an isolated process.
// Receives params via stdin (JSON), writes result to stdout (JSON), exits 0.
// Isolation is the point: Node.js perf_hooks.performance is a global singleton,
// so concurrent Lighthouse calls in the same process clear each other's marks,
// causing "performance mark has not been set" errors. Separate process = separate
// performance object = no conflicts.

const chromeLauncher = require('chrome-launcher');

let _lighthouse;
async function getLighthouse() {
  if (!_lighthouse) ({ default: _lighthouse } = await import('lighthouse'));
  return _lighthouse;
}

function buildLhFlags(strategy, categories, throttlingMethod, port) {
  return {
    logLevel:       'silent',
    output:         'json',
    onlyCategories: categories,
    port,
    formFactor:     strategy,
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

function extractResult(url, lhr) {
  const cats = lhr.categories || {};
  const aud  = lhr.audits     || {};
  const score = key => {
    const s = cats[key]?.score;
    return s != null ? Math.round(s * 100) : null;
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

(async () => {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { url, chromeFlags, strategy, categories, throttlingMethod } = JSON.parse(input);

  let chrome;
  try {
    chrome = await chromeLauncher.launch({ chromeFlags });
    const lighthouse = await getLighthouse();
    const result = await lighthouse(url, buildLhFlags(strategy, categories, throttlingMethod, chrome.port));
    const lhr = result?.lhr;
    if (!lhr) throw new Error('Lighthouse returned no result');
    if (lhr.runtimeError?.code) throw new Error(lhr.runtimeError.message || lhr.runtimeError.code);
    process.stdout.write(JSON.stringify(extractResult(url, lhr)));
  } catch (err) {
    process.stdout.write(JSON.stringify({ url, status: 'error', error: err.message }));
  } finally {
    if (chrome) try { await chrome.kill(); } catch {}
    process.exit(0);
  }
})();
