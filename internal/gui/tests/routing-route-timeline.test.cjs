// Full compact B request card regression; synthetic API only.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");
const t0 = Date.now() - 60e3;
const iso = (ms) => new Date(ms).toISOString();
const keyA = { id: "nim-a", provider: "nim", name: "Nimbus", kind: "key", who: "Key A", model: "nimbus-large", known: true, used: 64 };
const keyB = { id: "nim-b", provider: "nim", name: "Nimbus", kind: "key", who: "Key B", model: "nimbus-large", known: true, used: 18 };
const net = { own: 0.5, asks: 1, connect: 1.8, send: 0.3, wait: 400, head: 403 };
const prompt = { tokens: 6, counted: true, turns: 1, parts: [{ kind: "chat", tokens: 6, items: [{ name: "turn", tokens: 6 }] }] };
const answered = {
  prompt,
  session: "019a-session",
  id: 7, seq: 7, time: iso(t0), agent: "codex", model: "nim/nimbus-large", provider: "nim", order: [keyA, keyB],
  tries: [
    { id: keyA.id, model: keyA.model, start: iso(t0 + 30), done: true, status: 429, ms: 410, fail: "rate", again: 1000, error: "429 Too Many Requests: rate limited (synthetic)" },
    { id: keyB.id, model: keyB.model, start: iso(t0 + 1440), done: true, status: 200, ms: 8390, ttft: 1820, net },
  ],
  done: true, status: 200, ms: 9830, ttft: 3260, tokens: 1500, usage: [{ in: 6, cache_read: 94, out: 10 }],
};
// under way: a try out for some seconds, no answer yet; started as its
// test starts, so its time is still told in tenths
let t1 = 0;
const going = (seq) => ({
  prompt, session: "compact-session",
  id: 8, seq, time: iso(t1), agent: "codex", model: "nim/nimbus-large", provider: "nim", order: [keyA],
  tries: [{ id: keyA.id, model: keyA.model, start: iso(t1 + 100), done: false }],
  done: false, status: 0,
});

function serve(theme, routes, feed, lang = "en") {
  const state = { agents: [{ id: "codex", name: "Codex", path: "/test/codex", fields: [] }], profiles: [], settings: { lang, theme } };
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"${theme}",web:true};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json(state);
    if (url.pathname === "/api/gateway/trace") {
      const trace = (routes) => json({ mine: true, now: new Date().toISOString(), seq: routes[routes.length - 1].seq, totals: { requests: 0, rerouted: 0, errors: 0 }, routes });
      if (!url.searchParams.get("wait")) return trace(routes);
      if (!feed) return new Promise(() => {});
      return trace([await new Promise((res) => { feed.next = res; })]);
    }
    if (url.pathname === "/api/gateway/history") return json({ cut: false, days: [], routes: [] });
    if (url.pathname === "/api/groups") return json({ models: [], groups: [], pools: [] });
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true, url: "http://127.0.0.1:3999" } });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname === "/api/usage/quotas") return json([]);
    if (url.pathname === "/api/usage") return json({ calls: 0, errors: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, unpriced: 0, cost: 0, bucket: "day", series: [], agents: [], models: [], path: "" });
    if (url.pathname === "/api/sessions") return json({ sessions: [], dirs: [] });
    if (url.pathname === "/api/usage/quotas/history") return json([]);
    if (url.pathname === "/api/agents/cli") return json({ agents: {}, pending: false });
    if (url.pathname === "/api/plugin-panels" || url.pathname === "/api/plugin-pages") return json([]);
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await route.fulfill({ body: await fs.readFile(file), contentType });
  };
}


// The whole request card follows compact design B, not the former steps UI.
for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh", "zh-TW", "ja", "de"]) {
    test(
      engine + " " + lang + ": complete compact B card, disclosures and live outcomes",
      async t => {
        const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
        t.after(() => browser.close());
        const page = await browser.newPage({ viewport: { width: 1280, height: 1300 }, colorScheme: "dark" });
        page.setDefaultTimeout(5000);
        const errors = []; page.on('pageerror', e => errors.push(e.message));
        const feed = {};
        const previous = { ...answered, id: 6, seq: 6, session: "019a-session", prompt: { ...prompt, tokens: 39000 }, usage: [{ in: 3000, cache_read: 36000, out: 10 }] };
        await page.route('**/*', serve('dark', [previous, answered], feed, lang));
        await page.goto('http://magpie.test/?view=routing');
        await page.locator('.rt-selected').waitFor();
        const ctx = page.locator('.rt-ctx .ctx-card');
        await ctx.waitFor();
        assert.equal(await ctx.locator('.ctx-stat').count(), 3, 'used, cache and session figures appear together');
        const panel = page.locator('.rt-detail-panel');
        assert.equal(await panel.locator(':scope > *').evaluateAll(es => es.map(e => e.className)).then(a => a.join('|')), 'rt-log-head|rt-route|rt-diag|rt-bodies');
        assert.equal(await panel.locator('.rt-hero > *').evaluateAll(es => es.map(e => e.className)).then(a => a.join('|')), 'rt-sum|rt-hero-heading|rt-meta');
        assert.equal(await panel.locator('.rt-log-head button').count(), 3, 'all three real actions have the draft positions');
        assert.equal(await panel.locator('.rt-outcome').count(), 1);
        assert.equal(await panel.locator('.rt-stat').count(), 4, 'four stable metrics, unknown values remain unknown');
        assert.match(await panel.locator('.rt-selected').textContent(), /Key B/);
        assert.equal(await panel.locator('.rt-selected-tag').count(), 1);
        assert.match(await panel.locator('.rt-result').textContent(), /Codex/);
        assert.equal(await panel.locator('.rt-result time').count(), 1);
        assert.equal(await panel.locator('.rt-st, .rt-steps, .rt-gantt, .rt-axis, .rt-lane').count(), 0, 'the former UI is removed');
        const candidates=panel.locator('.rt-decision-more'), fine=panel.locator('.rt-time-fine'), info=panel.locator('.rt-diag');
        for(const d of [candidates,fine,info]){assert.equal(await d.evaluate(e=>e.open),false);await d.locator(':scope > summary').dispatchEvent('click');}
        assert.match(await candidates.textContent(), /Key A.*429/);
        assert.match(await info.locator('.rt-request-notes').textContent(), /429 Too Many Requests/);
        assert.equal(await info.locator('dt').count(),5);
        const updated=structuredClone(answered);updated.seq++;updated.tries[1].net.connect=3.8;
        for(let i=0;i<100&&!feed.next;i++)await page.waitForTimeout(20);assert(feed.next);feed.next(updated);
        await page.waitForFunction(()=>document.querySelector('.rt-analysis .rt-time-parts').textContent.includes('3.8'));
        for(const d of [candidates,fine,info])assert.equal(await d.evaluate(e=>e.open),true,'expansion survives readings update');
        for(const width of [1280,800,420,320]){
          await page.setViewportSize({width,height:1300});await page.waitForTimeout(120);
          const dims=await panel.evaluate(e=>{const a=e.querySelector('.rt-decision').getBoundingClientRect(),b=e.querySelector('.rt-timing').getBoundingClientRect(),r=e.getBoundingClientRect(),route=e.querySelector('.rt-route'),analysis=e.querySelector('.rt-analysis'),result=e.querySelector('.rt-result');return {width:r.width,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,across:b.left>=a.right-1&&Math.abs(b.top-a.top)<1,gap:result.getBoundingClientRect().top-analysis.getBoundingClientRect().bottom,held:route.style.minHeight};});
          if(width===1280)assert(dims.width>800,"request detail expands to the original context width");assert.equal(dims.overflow,false);assert.equal(dims.held,'');assert(dims.gap<20,'no stale blank height');
          if(width===1280)assert(dims.across);if(width<=420)assert.equal(dims.across,false);
          const context = await page.locator('.rt-ctx .ctx-card').evaluate(e => {
            const r=e.getBoundingClientRect(), p=document.querySelector('.rt-detail-panel').getBoundingClientRect(), stats=e.querySelector('.ctx-top').getBoundingClientRect();
            return { left:r.left, right:r.right, panelLeft:p.left, panelRight:p.right, statHeight:stats.height,
              tile:[...e.querySelectorAll('.ctx-stat')].some(s=>parseFloat(getComputedStyle(s).borderTopWidth)>0 && parseFloat(getComputedStyle(s).borderRightWidth)>0) };
          });
          assert(Math.abs(context.left-context.panelLeft)<1 && Math.abs(context.right-context.panelRight)<1,'context and request share the reading column');
          assert.equal(context.tile,false,'context figures are a compact strip, not nested tiles');
          if(width===1280)assert(context.statHeight<140,'context figures do not reserve tall empty tiles');
        }
        await page.setViewportSize({width:1280,height:1300});
        if(process.env.ARTIFACT_DIR)await panel.screenshot({path:path.join(process.env.ARTIFACT_DIR,lang+'-compact-B-full.png')});
        // A new request restores collapsed raw details, keeps real actions
        // in place, and reports its live duration without inventing metrics.
        t1=Date.now()-2500;for(let i=0;i<100&&!feed.next;i++)await page.waitForTimeout(20);feed.next(going(9));
        await page.waitForFunction(()=>document.querySelector('.rt-badge').classList.contains('live'));
        assert.equal(await info.evaluate(e=>e.open),false);
        assert.equal(await panel.locator('.rt-log-head button:disabled').count(),3);
        assert.equal(await panel.locator('.rt-stat').count(),4);
        assert.equal(await panel.locator('.rt-result.live').count(),1);
        assert.equal(await panel.locator('.rt-badge').isVisible(),false,'a normal running request has one status heading');
        const clock=panel.locator('.rt-live-elapsed');
        await clock.waitFor();
        const beforeClock=await clock.textContent();
        await page.waitForFunction(was=>document.querySelector('.rt-live-elapsed').textContent!==was,beforeClock);
        assert.equal(await panel.locator('.rt-time-bar').count(),0,'no invented phase proportions for a running request without measurements');
        await page.waitForFunction(()=>document.querySelector('.rt-cap').hidden);
        assert.equal(await page.locator('.rt-cap').isVisible(),false,'duplicate caption is visually hidden, not just marked hidden');
        const retried=going(10);
        retried.tries.unshift({id:keyA.id,model:keyA.model,start:iso(t1-500),done:true,status:429,ms:400,net:{own:1,send:1,wait:398},fail:'rate',error:'synthetic retry'});
        for(let i=0;i<100&&!feed.next;i++)await page.waitForTimeout(20);feed.next(retried);
        await page.waitForFunction(()=>!document.querySelector('.rt-badge').hidden);
        assert.match(await panel.locator('.rt-badge').textContent(),/2/,'retry badge adds information instead of repeating the heading');
        assert(await panel.locator('.rt-live-elapsed').isVisible());
        assert(await panel.locator('.rt-time-sum').isVisible(),'recorded earlier attempts coexist with the live clock');
        const bad=going(11);Object.assign(bad,{done:true,status:429,ms:2700});Object.assign(bad.tries[0],{done:true,status:429,ms:2600,fail:'rate',error:'synthetic rate limit'});
        for(let i=0;i<100&&!feed.next;i++)await page.waitForTimeout(20);feed.next(bad);
        await page.waitForFunction(()=>document.querySelector('.rt-result').classList.contains('bad'));
        assert.equal(await panel.locator('.rt-log-head button:disabled').count(),0);
        await info.locator(':scope > summary').dispatchEvent('click');
        assert.match(await info.textContent(),/synthetic rate limit/);
        assert.deepEqual(errors,[]);
      }
    );
  }
}

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ['chromium', 'webkit'])) {
  test(`${engine}: opening request bodies pins the inspected request while newer calls arrive`, async t => {
    const browser=await (engine==='webkit'?webkit.launch():chromium.launch({channel:'chromium'}));
    t.after(()=>browser.close());
    const page=await browser.newPage({viewport:{width:1280,height:1000}}), feed={}, errors=[], calls=[];
    page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',serve('light',[answered],feed,'en'));
    await page.route('**/api/gateway/call?*',route=>{calls.push(new URL(route.request().url()).searchParams.get('route'));return route.fulfill({json:{requestBody:'{"marker":"inspected-request-7"}',responseBody:'{"marker":"inspected-response-7"}',requestTruncated:false,responseTruncated:false}});});
    await page.goto('http://magpie.test/?view=routing');await page.locator('.rt-selected').waitFor();
    const radius=await page.locator('.rt-selected').evaluate(e=>parseFloat(getComputedStyle(e).borderTopLeftRadius));
    assert(radius>=6,'selected-account surface has rounded corners');
    await page.locator('.rt-bodies-b').dispatchEvent('click');
    await page.waitForFunction(()=>document.querySelector('.rt-bodies').textContent.includes('inspected-response-7'));
    assert.equal(await page.locator('.rt-bodies').evaluate(e=>e.hidden),false);
    assert.equal(await page.locator('.rt-bodies-b').getAttribute('aria-expanded'),'true');
    const newer=structuredClone(answered);newer.id=99;newer.seq=99;newer.time=iso(Date.now());
    for(let i=0;i<100&&!feed.next;i++)await page.waitForTimeout(20);assert(feed.next);feed.next(newer);
    await page.waitForFunction(()=>document.querySelectorAll('.rt-req').length>=2);
    assert.equal(await page.locator('.rt-bodies').evaluate(e=>e.hidden),false,'new trace does not hide the open bodies');
    assert.match(await page.locator('.rt-bodies').textContent(),/inspected-response-7/);
    assert.deepEqual(calls,['7'],'inspection continues to use the clicked request');
    await page.locator('.rt-bodies-b').dispatchEvent('click');
    assert.equal(await page.locator('.rt-bodies').evaluate(e=>e.hidden),true);
    assert.deepEqual(errors,[]);
  });
}
