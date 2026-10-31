const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { chromium, webkit } = require('playwright');
const assets = process.env.MAGPIE_TEST_ASSETS || path.resolve(__dirname, '../assets');
const link = 'https://accounts.example.invalid/verify?token=fixture&next=1';
const refusal = (url) => `Verify your account — this Google account needs to be verified: open ${url} in a browser signed in to it, verify it, then try again`;

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ['chromium', 'webkit'])) {
  for (const lang of ['en', 'zh', 'zh-TW', 'ja', 'de']) {
    test(`${engine} ${lang}: model verification stays actionable and disappears after a successful retry`, async (t) => {
      const browser = await (engine === 'webkit' ? webkit : chromium).launch();
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width: 900, height: 720 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(6000);
      const posts = [], errors = [];
      let error = refusal(link), openFails = false;
      const provider = { id: 'relay', name: 'Relay', icon: 'generic', chat: 'https://relay.example.invalid/v1',
        models: [{ id: 'gemini-test', name: 'gemini-test', on: true }], agents: [], ready: true, key: { set: true, masked: 'fixture' } };
      page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/*', async (route) => {
        const u = new URL(route.request().url());
        const json = (data) => route.fulfill({ json: data });
        if (u.pathname === '/boot.js') return route.fulfill({ contentType: 'text/javascript', body: `window.bootPrefs={lang:${JSON.stringify(lang)},theme:'light',web:false};` });
        if (u.pathname === '/wails/runtime.js') return route.fulfill({ contentType: 'text/javascript', body: 'export const Window = {};' });
        if (u.pathname === '/api/state') return json({ agents: [], profiles: [], settings: { lang, theme: 'light' } });
        if (u.pathname === '/api/providers') return json({ providers: [provider], presets: [], excluded: [], gateway: { running: true, window: true } });
        if (u.pathname === '/api/provider/test') return json({ results: [{ model: 'gemini-test', protocol: 'chat', ok: !error, status: error ? 403 : 200, error, ms: 1 }] });
        if (u.pathname === '/api/open') {
          posts.push(route.request().postDataJSON());
          return openFails ? route.fulfill({ status: 500, json: { error: 'fixture open failed' } }) : json({});
        }
        if (u.pathname.startsWith('/api/')) return json({});
        if (u.hostname !== 'magpie.test') return route.abort();
        const file = path.join(assets, u.pathname === '/' ? 'index.html' : u.pathname);
        try { await route.fulfill({ body: await fs.readFile(file), contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(file)] }); }
        catch { await route.fulfill({ status: 404, body: '' }); }
      });
      await page.goto('http://magpie.test/?view=providers');
      await page.locator('.row.provider[data-id="relay"]').click();
      const L = await page.evaluate((lang) => {
        const keys = ['Test models', 'Open verification', 'Test this model'];
        return Object.fromEntries(keys.map((k) => [k, lang === 'en' ? k : I18N[lang][k]]));
      }, lang);
      assert(L['Open verification'], 'verification action is translated');
      const run = page.getByRole('button', { name: L['Test models'], exact: true });
      const notice = page.locator('.model-verification');
      await run.click();
      await notice.waitFor();
      assert.equal(await notice.locator('span').textContent(), error);
      assert.equal(posts.length, 0, 'the browser only opens when requested');
      await notice.getByRole('button', { name: L['Open verification'], exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.model-verification button').classList.contains('busy'));
      assert.deepEqual(posts, [{ url: link }]);
      openFails = true;
      await notice.getByRole('button').click();
      await page.waitForFunction(() => document.querySelector('#status').textContent.includes('fixture open failed'));
      assert(await notice.isVisible(), 'an opening error keeps the action available');
      for (const invalid of ['http://example.invalid/verify', 'javascript:alert(1)', 'https://', 'https://user:password@example.invalid/']) {
        error = refusal(invalid);
        await run.click();
        await page.waitForFunction(() => !document.querySelector('.models .busy'));
        assert.equal(await notice.isVisible(), false, invalid);
      }
      error = refusal(link);
      await run.click();
      await notice.waitFor();
      error = '';
      await run.click();
      await page.waitForFunction(() => document.querySelector('.model-verification').hidden);
      assert.deepEqual(errors, []);
    });
  }
}
