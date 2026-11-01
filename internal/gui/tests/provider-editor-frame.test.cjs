// Provider editors keep a useful, stable frame while their fields change.
// API responses are synthetic; no native window or real accounts are used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { chromium, webkit } = require('playwright');
const assets = process.env.MAGPIE_REPAIR_ASSETS || path.resolve(__dirname, '../assets');
const provider = { id: 'alpha', name: 'Alpha', icon: 'generic', chat: 'https://alpha.example/v1', url: 'https://alpha.example/v1', host: 'alpha.example',
  models: Array.from({length: 12}, (_, i) => ({id: 'model-' + i, on: true})), agents: [], fallback: [], headers: {}, keyList: [], proxy: '', key: {set: true, masked: 'sk-test'}, ready: true };
async function serve(route) {
  const u = new URL(route.request().url()), json = data => route.fulfill({json: data});
  if (u.pathname === '/boot.js') return route.fulfill({contentType: 'text/javascript', body: 'window.bootPrefs={lang:"en",theme:"light",web:false};'});
  if (u.pathname === '/wails/runtime.js') return route.fulfill({contentType: 'text/javascript', body: 'export const Window={};'});
  if (u.pathname === '/api/state') return json({agents: [], profiles: [], settings: {lang: 'en', theme: 'light'}});
  if (u.pathname === '/api/providers') return json({providers: [provider], presets: [], excluded: [], gateway: {running: true, window: true}});
  if (u.pathname === '/api/groups') return json({groups: [], pools: []});
  if (u.pathname.startsWith('/api/')) return json({});
  if (u.host !== 'magpie.test' || !/^\/[\w./-]*$/.test(u.pathname)) return route.fulfill({status: 404});
  const file = path.join(assets, u.pathname === '/' ? 'index.html' : u.pathname);
  try { return route.fulfill({body: await fs.readFile(file), contentType: {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png'}[path.extname(file)]}); }
  catch { return route.fulfill({status: 404}); }
}
const settled = page => page.waitForFunction(() => {
  const d = document.querySelector('#modal .dialog');
  return d && !d.getAnimations({subtree: true}).some(a => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity);
});
const geometry = page => page.evaluate(() => {
  const d = document.querySelector('#modal .dialog'), r = d.getBoundingClientRect(), body = d.querySelector('.ebody'), bar = d.querySelector('.bar').getBoundingClientRect();
  return {top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height, body: body.clientHeight, scroll: body.scrollTop, room: body.scrollHeight - body.clientHeight, barBottom: bar.bottom};
});
for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ['chromium', 'webkit'])) {
  test(`${engine}: provider editor keeps its frame through folds, resize and reopen`, async t => {
    const browser = await (engine === 'webkit' ? webkit.launch() : chromium.launch({channel: 'chromium'}));
    t.after(() => browser.close());
    const page = await browser.newPage({viewport: {width: 1240, height: 900}});
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', serve);
    await page.goto('http://magpie.test/?view=providers');
    await page.locator('.row.provider[data-id="alpha"]').click();
    await settled(page);
    const before = await geometry(page), stages = [];
    for (const label of ['Advanced', 'More endpoints', 'Names & levels', 'Fold', 'More endpoints', 'Advanced']) {
      await page.locator('#modal summary, #modal button').filter({hasText: new RegExp('^' + label + '$')}).first().click();
      await settled(page);
      stages.push({label, ...await geometry(page)});
    }
    t.diagnostic(JSON.stringify({before, stages}));
    for (const stage of stages) {
      assert(Math.abs(stage.top - before.top) < 1, `top changed on ${stage.label}: ${before.top} -> ${stage.top}`);
      assert(Math.abs(stage.height - before.height) < 1, `height changed on ${stage.label}: ${before.height} -> ${stage.height}`);
      assert(stage.body > 0 && stage.barBottom <= stage.bottom + 1, 'fields scroll with Save visible');
    }
    assert.equal(before.width, 800, 'desktop editor has room for URLs, model names and account controls');
    assert.equal(before.height, 760);
    for (const size of [{width: 600, height: 450}, {width: 360, height: 640}, {width: 1240, height: 900}]) {
      await page.setViewportSize(size);
      await page.waitForFunction(({width, height}) => {
        const r = document.querySelector('#modal .dialog').getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= width + 1 && r.bottom <= height + 1;
      }, size);
      const g = await geometry(page);
      assert(g.body > 0 && g.barBottom <= size.height, 'body and Save remain usable on a small window');
      if (size.width === 1240) assert.equal(g.height, 760, 'restoring the window releases the small-window height limit');
    }
    await page.locator('#modal button').filter({hasText: /^Cancel$/}).click();
    await page.locator('#modal').waitFor({state: 'hidden'});
    await page.locator('.row.provider[data-id="alpha"]').click();
    await settled(page);
    const reopened = await geometry(page);
    assert(Math.abs(reopened.top - before.top) < 1 && reopened.height === before.height, 'reopening keeps the same frame');
    assert.deepEqual(errors, []);
  });
}
