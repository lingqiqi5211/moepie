// Run with Node's test runner and Playwright on the module path; see README.md.
// Routing's live stage is a window of its own: as tall as the view has
// room for (70% of it, at least 360px), never as tall as the stage is, so
// accounts coming in scroll in it and the requests under it stay where
// they are. It zooms, 50% to 200%, by its buttons and by Ctrl and the
// wheel (the page itself neither zooms nor scrolls), fits the whole stage
// in, and keeps its zoom across a reload; at each zoom every wire still
// ends at its account. In Chromium and WebKit, in English and Chinese.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");
const iso = (ms) => new Date(ms).toISOString();
const M = "model-a";
// forty providers of a key each, each its own row on the stage
const pools = Array.from({ length: 40 }, (_, i) => [`pool${i}`, `Pool ${i}`]);
const seat = ([p, name]) => ({ id: `${p}#k0`, provider: p, name, who: `sk-…${p}`, kind: "key", model: M });
const providers = pools.map(([p, name]) => ({ id: p, name, models: [], agents: [], key: { set: true, masked: "sk-…" }, keyList: [{ id: "k0" }] }));

// a request to the group, which weighed the first n providers' keys
function req(id, n) {
  const order = pools.slice(0, n).map(seat), t0 = Date.now() - 500;
  const group = { id: "g", name: "G", routing: "", members: pools.slice(0, n).map(([p]) => `${p}/${M}`) };
  return { id, seq: id, time: iso(t0), agent: "codex", model: "g", provider: order[0].provider, group, order,
    tries: [{ id: order[0].id, model: M, start: iso(t0), done: true, status: 200, ms: 300 }], done: true, status: 200, ms: 400, tokens: 1200 };
}

function serve(lang, feed) {
  const first = Array.from({ length: 6 }, (_, i) => req(1 + i, 3));
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:true};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [{ id: "codex", name: "Codex", path: "/test/config.toml", fields: [] }], profiles: [], settings: { lang, theme: "light" } });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname === "/api/gateway/trace") {
      const trace = (routes) => json({ mine: true, now: new Date().toISOString(), seq: routes.length ? routes[routes.length - 1].seq : Number(url.searchParams.get("after")), totals: { requests: 0, rerouted: 0, errors: 0 }, routes });
      if (!url.searchParams.get("wait")) return trace(first);
      for (let i = 0; i < 25 && !feed.q.length && !feed.closed; i++) await new Promise((r) => setTimeout(r, 20));
      return trace(feed.q.splice(0)).catch(() => {});
    }
    if (url.pathname === "/api/gateway/history") return json({ cut: false, days: [], routes: [] });
    if (url.pathname === "/api/groups") return json({ models: [], groups: [], pools: [] });
    if (url.pathname === "/api/providers") return json({ providers, excluded: [], gateway: { running: true, window: true, url: "http://127.0.0.1:3999" } });
    if (url.pathname === "/api/usage/quotas") return json([]);
    if (url.pathname.startsWith("/api/")) return json({});
    const file = process.env.MAGPIE_ROUTING_CLIENT && url.pathname === "/plugins/routing/client.js" ? process.env.MAGPIE_ROUTING_CLIENT : path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await route.fulfill({ body: await fs.readFile(file), contentType });
  };
}

// laid out: two frames, the stage's wires drawn in the second
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));

// the window, the requests under it, the view, and the zoom as drawn
const where = (page) => page.evaluate(() => {
  const v = document.querySelector("#view-routing"), c = v.querySelector(".rt-canvas"), st = v.querySelector(".rt-stage");
  const r = c.getBoundingClientRect();
  return { h: r.height, top: r.top, left: r.left, w: r.width, scrollH: c.scrollHeight, inner: c.clientHeight, reqs: v.querySelector(".rt-reqs").getBoundingClientRect().top + v.scrollTop,
    view: v.clientHeight, viewTop: v.scrollTop, k: st.getBoundingClientRect().width / st.offsetWidth, said: v.querySelector(".rt-zoom-at").textContent,
    stageH: st.getBoundingClientRect().height, stageW: st.getBoundingClientRect().width, cw: c.clientWidth,
    // the card's other parts, under the window: the log grows a line a request
    rest: [...v.querySelector(".rt").children].filter((e) => !e.classList.contains("rt-pane")).reduce((a, e) => a + e.getBoundingClientRect().height, 0) };
});

// the accounts in the window's sight whose wire doesn't end at the middle
// of their left edge, the wires' ends taken from the stage's own px to the
// page's by the zoom; given a moment, as rows coming in are wired mid-way
// in (by 4px) and drawn where they land by a later layout
const unwired = async (page) => {
  let got;
  for (let i = 0; i < 20; i++) {
    await frames(page);
    if (!(got = await wireEnds(page)).off.length) break;
    await page.waitForTimeout(100);
  }
  return got;
};
const wireEnds = (page) => page.evaluate(() => {
  const v = document.querySelector("#view-routing"), c = v.querySelector(".rt-canvas").getBoundingClientRect(), stage = v.querySelector(".rt-stage");
  const st = stage.getBoundingClientRect(), z = st.width / stage.offsetWidth;
  const ends = [...v.querySelectorAll(".rt-wires path[d]")].map((p) => { const n = p.getAttribute("d").match(/-?[\d.]+(?:e-?\d+)?/g).map(Number); return [n[n.length - 2] * z + st.left, n[n.length - 1] * z + st.top]; });
  const rows = [...v.querySelectorAll(".rt-accts > li:not(.rt-gap)")].filter((li) => { const r = li.getBoundingClientRect(); return r.top >= c.top && r.bottom <= c.bottom; });
  const off = rows.filter((li) => { const r = li.getBoundingClientRect(); return !ends.some(([x, y]) => Math.abs(x - r.left) < 1.5 && Math.abs(y - (r.top + r.bottom) / 2) < 1.5); }).map((li) => li.title.split("\n")[0]);
  return { rows: rows.length, off: rows.length ? off : ["(no account in sight)"] };
});

const want = (view) => Math.round(Math.max(360, view * .7));

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh"]) {
    test(`${engine} ${lang}: the live stage is a window of its own, zoomed in it`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const feed = { q: [], closed: false };
      await page.route("**/*", serve(lang, feed));
      t.after(async () => { feed.closed = true; await browser.close(); });
      await page.goto("http://magpie.test/?view=routing");
      await page.locator("#view-routing .rt-req").nth(5).waitFor();
      await page.waitForTimeout(600);
      const cardWidth = () => page.locator('.rt-accts > li').first().evaluate((e) => e.getBoundingClientRect().width);
      const baseCard = await cardWidth();
      await page.locator('.rt-zoom-out').click();
      await frames(page);
      assert(Math.abs(await cardWidth() - baseCard * .9) < 1, 'zoom must shrink the account card proportionally, without stretching its layout');
      await page.locator('.rt-zoom-at').click();
      await frames(page);
      const cardBox = await page.locator('.rt-accts > li:not(.rt-fold):not(.rt-sub):not(.rt-gap)').first().boundingBox();
      const sceneBefore = await page.locator('.rt-stage').boundingBox();
      await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(cardBox.x + cardBox.width / 2 + 60, cardBox.y + cardBox.height / 2 + 30, { steps: 8 });
      await page.mouse.up();
      await frames(page);
      const sceneAfter = await page.locator('.rt-stage').boundingBox();
      assert(Math.abs(sceneAfter.x - sceneBefore.x - 60) < 2 && Math.abs(sceneAfter.y - sceneBefore.y - 30) < 2, 'a drag starting on a card pans the canvas instead of requiring blank space');
      await page.locator('.rt-zoom-at').click();
      await frames(page);

      // The fixed canvas owns wheel movement, even when the scene is small;
      // blank space on every side also lets the reader drag at 50%.
      const fits = await where(page);
      assert.equal(fits.viewTop, 0);
      const innerTop = await page.locator('.rt-canvas').evaluate((c) => c.scrollTop);
      await page.mouse.move(fits.left + fits.w / 2, fits.top + fits.h / 2);
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(300);
      assert.equal((await where(page)).viewTop, 0, "the fixed canvas does not scroll the page");
      assert(await page.locator('.rt-canvas').evaluate((c) => c.scrollTop) > innerTop, "the wheel pans the canvas");
      await page.locator('.rt-zoom-at').click();
      await frames(page);

      // forty accounts come in: the stage outgrows its window, which keeps
      // its height, and the requests under it stay where they are (moved
      // only by the log over them, a line longer for the request)
      const was = await where(page);
      assert.equal(was.h, want(was.view), `the window is 70% of the view: ${JSON.stringify(was)}`);
      assert.equal(was.said, "100%");
      feed.q.push(req(7, 40));
      await page.waitForFunction(() => document.querySelectorAll("#view-routing .rt-accts > li").length >= 40);
      await page.waitForTimeout(400);
      const grown = await where(page);
      assert(grown.scrollH > grown.inner + 200, `the stage scrolls in its window: ${JSON.stringify(grown)}`);
      assert.equal(grown.h, was.h, "the window keeps its height");
      assert(Math.abs(grown.reqs - was.reqs - (grown.rest - was.rest)) < 1, `the requests stay where they were: ${JSON.stringify([was, grown])}`);
      assert.equal(grown.viewTop, was.viewTop, "the page doesn't scroll");
      assert.deepEqual((await unwired(page)).off, [], "a wire ends at each account in sight");
      // the agent and magpie, beside the first accounts, in sight unscrolled
      const cards = await page.evaluate(() => {
        const v = document.querySelector("#view-routing"), c = v.querySelector(".rt-canvas"), r = c.getBoundingClientRect();
        const box = { top: r.top + c.clientTop, bottom: r.top + c.clientTop + c.clientHeight, left: r.left, right: r.left + c.clientWidth };
        const out = (e) => { const x = e.getBoundingClientRect(); return !x.height || x.top < box.top || x.bottom > box.bottom || x.left < box.left || x.right > box.right; };
        return { wide: !v.querySelector(".rt-stage").classList.contains("max560"), scrollTop: c.scrollTop, out: [...v.querySelectorAll(".rt-srcs > .rt-node, .rt-stage > .rt-hub")].filter(out).map((e) => e.textContent.trim().slice(0, 20)), n: v.querySelectorAll(".rt-srcs > .rt-node, .rt-stage > .rt-hub").length };
      });
      assert(cards.wide && cards.scrollTop > 0 && cards.n >= 2, `wide with pan room: ${JSON.stringify(cards)}`);
      assert.deepEqual(cards.out, [], "the agent and magpie are in the window's sight");
      // A resize can measure a key mid-shake. Its wire must return to the
      // settled card without another request or scroll to redraw it.
      await page.locator('.rt-accts > li:not(.rt-fold):not(.rt-sub):not(.rt-gap)').first().evaluate((e) => {
        e.classList.add('hit');
        const a = e.getAnimations().find((a) => a.animationName === 'rthit');
        a.pause(); a.currentTime = 90;
        window.__settlingHit = a;
      });
      await page.setViewportSize({ width: 1201, height: 800 });
      await frames(page);
      await page.evaluate(() => window.__settlingHit.finish());
      await frames(page);
      assert.deepEqual((await unwired(page)).off, [], 'wires return to settled rows after an animation ends');
      await page.setViewportSize({ width: 1200, height: 800 });
      await frames(page);
      // overflowing, it keeps the wheel, at its end too: the page stays put
      await page.mouse.move(grown.left + grown.w / 2, grown.top + grown.h / 2);
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(300);
      assert(await page.locator("#view-routing .rt-canvas").evaluate((c) => c.scrollTop) > 0, "a wheel over it scrolls the window");
      await page.locator("#view-routing .rt-canvas").evaluate((c) => { c.scrollTop = c.scrollHeight; });
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(300);
      assert.equal((await where(page)).viewTop, grown.viewTop, "at its end, the page doesn't scroll");
      await page.locator("#view-routing .rt-canvas").evaluate((c) => { c.scrollTop = parseFloat(c.querySelector('.rt-stage').style.top); });

      // 70% of the view, at least 360px
      for (const height of [560, 1400, 900, 800]) {
        await page.setViewportSize({ width: 1200, height });
        await frames(page);
        await page.waitForTimeout(100);
        const w = await where(page);
        assert.equal(w.h, want(w.view), `${height}px tall: ${JSON.stringify(w)}`);
        assert(w.h >= 360);
      }

      // the buttons: in and out by steps, kept within 50% to 200%; the
      // readout puts it back to 100%
      const k = async () => { await frames(page); return where(page); };
      const zIn = page.locator("#view-routing .rt-zoom-in"), zOut = page.locator("#view-routing .rt-zoom-out");
      const zAt = page.locator("#view-routing .rt-zoom-at");
      for (const b of [zIn, zOut, zAt]) assert((await b.getAttribute("title"))?.length > 3 && (await b.getAttribute("aria-label"))?.length > 3, "each button says what it does");
      assert.match(await zAt.getAttribute("aria-label"), /^100% · /, "the readout says its zoom");
      await zIn.click();
      let z = await k();
      assert.equal(z.said, "110%");
      assert(Math.abs(z.k - 1.1) < .01, `drawn at 110%: ${z.k}`);
      await zOut.click();
      await zOut.click();
      z = await k();
      assert.equal(z.said, "90%");
      for (let i = 0; i < 12; i++) if (await zOut.isEnabled()) await zOut.click();
      z = await k();
      assert.equal(z.said, "50%");
      assert(Math.abs(z.k - .5) < .01);
      assert.equal(await zOut.isDisabled(), true, "no further out than 50%");
      assert(Math.abs(z.stageW - z.cw * .5) < 1.5, `at 50% the scene shrinks as one: ${JSON.stringify(z)}`);
      const halfCard = await page.locator('.rt-accts > li').first().evaluate((e) => e.getBoundingClientRect().width);
      await zAt.click();
      const wholeCard = await page.locator('.rt-accts > li').first().evaluate((e) => e.getBoundingClientRect().width);
      assert(Math.abs(wholeCard * .5 - halfCard) < 1, "account cards shrink proportionally instead of stretching");
      for (let i = 0; i < 12; i++) if (await zOut.isEnabled()) await zOut.click();
      const beforePan = await page.locator('.rt-stage').boundingBox();
      const canvasBox = await page.locator('.rt-canvas').boundingBox();
      await page.mouse.move(canvasBox.x + 12, canvasBox.y + 12);
      await page.mouse.down();
      await page.mouse.move(canvasBox.x + 92, canvasBox.y + 52, { steps: 8 });
      await page.mouse.up();
      await frames(page);
      const afterPan = await page.locator('.rt-stage').boundingBox();
      assert(Math.abs(afterPan.x - beforePan.x - 80) < 2 && Math.abs(afterPan.y - beforePan.y - 40) < 2, "dragging moves the whole scene in both axes even at 50%");
      assert.equal((await where(page)).viewTop, grown.viewTop, "dragging leaves the page in place");
      await zAt.click();
      for (let i = 0; i < 12; i++) if (await zOut.isEnabled()) await zOut.click();
      assert.deepEqual((await unwired(page)).off, [], "at 50%, a wire ends at each account");
      await zAt.click();
      z = await k();
      assert.equal(z.said, "100%");
      assert(Math.abs(z.k - 1) < .001);
      for (let i = 0; i < 12; i++) if (await zIn.isEnabled()) await zIn.click();
      z = await k();
      assert.equal(z.said, "200%");
      assert.equal(await zIn.isDisabled(), true, "no further in than 200%");
      await zAt.click();

      // 150%, its wires at its accounts, scrolled down the window too
      await page.evaluate(() => localStorage.removeItem("magpie.routingStageZoom"));
      await zIn.click(); await zIn.click(); await zIn.click();
      z = await k();
      assert.equal(z.said, "150%");
      assert.deepEqual((await unwired(page)).off, [], "at 150%, a wire ends at each account");
      await page.locator("#view-routing .rt-canvas").evaluate((c) => { c.scrollTop = c.scrollHeight / 2; });
      await page.waitForTimeout(300);
      const mid = await unwired(page);
      assert(mid.rows > 0 && !mid.off.length, `at 150% scrolled, a wire ends at each account: ${JSON.stringify(mid)}`);

      // kept across a reload
      assert.equal(await page.evaluate(() => localStorage.getItem("magpie.routingStageZoom")), "1.5");
      await page.reload();
      await page.locator("#view-routing .rt-req").nth(5).waitFor();
      await page.waitForTimeout(600);
      z = await k();
      assert.equal(z.said, "150%");
      assert(Math.abs(z.k - 1.5) < .01, `drawn at 150% after a reload: ${z.k}`);
      feed.q.push(req(8, 40));
      await page.waitForFunction(() => document.querySelectorAll("#view-routing .rt-accts > li").length >= 40);
      await page.waitForTimeout(400);

      // Ctrl and the wheel zoom the stage, not the page: the wheel's own
      // scroll and the browser's zoom are both stopped
      await zAt.click();
      await page.evaluate(() => { window.__wheels = []; addEventListener("wheel", (e) => window.__wheels.push(e.defaultPrevented), { passive: true }); });
      const before = await k();
      await page.mouse.move(before.left + before.w / 2, before.top + before.h / 2);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(200);
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(200);
      await page.keyboard.up("Control");
      const zoomed = await k();
      assert(zoomed.k > 1.2, `Ctrl and the wheel zoomed in: ${zoomed.said}`);
      assert.equal(zoomed.viewTop, before.viewTop, "the page didn't scroll");
      assert.deepEqual(await page.evaluate(() => window.__wheels), [true, true], "the wheel's own scroll and zoom are stopped");
      await page.keyboard.down("Control");
      for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 400);
      await page.keyboard.up("Control");
      await page.waitForTimeout(200);
      assert.equal((await k()).said, "50%", "Ctrl and the wheel no further out than 50%");
      // over the zoom's own buttons too, the stage zooms and not the page
      const bar = await page.locator("#view-routing .rt-zoom").boundingBox();
      await page.mouse.move(bar.x + 4, bar.y + bar.height / 2);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -100);
      await page.keyboard.up("Control");
      await page.waitForTimeout(200);
      assert.notEqual((await k()).said, "50%", "Ctrl and the wheel over the zoom zoom the stage");
      assert(!(await page.evaluate(() => window.__wheels)).includes(false), "and not the page");

      // The viewport preference changes its height, independently of zoom,
      // and survives reloading without changing the default for other users.
      const sizes = lang === "zh" ? ["紧凑画布", "标准画布", "宽裕画布"] : ["Compact canvas", "Standard canvas", "Large canvas"];
      const heightPick = page.locator('.rt-height');
      const chooseSize = async (name) => {
        await heightPick.click();
        await page.getByRole('menuitemradio', { name, exact: true }).click();
        await frames(page);
      };
      const zoomBeforeSize = (await k()).said;
      await chooseSize(sizes[0]);
      let sizedView = await k();
      assert.equal(sizedView.h, Math.round(Math.max(240, sizedView.view * .45)), 'compact viewport gives room back to the request details');
      assert.equal(sizedView.said, zoomBeforeSize, 'height never changes zoom');
      assert.equal(await page.evaluate(() => localStorage.getItem('magpie.routingStageSize')), 'compact');
      await page.reload();
      await page.locator('#view-routing .rt-req').nth(5).waitFor();
      await frames(page);
      sizedView = await k();
      assert.equal(await heightPick.textContent(), sizes[0]);
      assert.equal(sizedView.h, Math.round(Math.max(240, sizedView.view * .45)), 'compact viewport is kept after reload');
      await chooseSize(sizes[2]);
      sizedView = await k();
      assert.equal(sizedView.h, Math.round(Math.max(360, sizedView.view * .9)), 'large viewport is available');
      await chooseSize(sizes[1]);
      sizedView = await k();
      assert.equal(sizedView.h, want(sizedView.view), 'standard restores the existing height');

      const pending = req(9, 3);
      pending.done = false;
      delete pending.ms;
      pending.tries[0].done = false;
      delete pending.tries[0].ms;
      feed.q.push(pending);
      await page.waitForFunction((expected) => document.querySelector('.rt-detail-panel')?.textContent?.includes(expected), lang === 'zh' ? '回答中' : 'Reply in progress');
      const elapsed = await page.locator('.rt-stat b').first().textContent();
      assert.match(elapsed, /\d/, 'running request keeps its measured clock');
      assert(!elapsed.includes('…'), 'running duration has no unexplained ellipsis');
      assert.deepEqual(errors, []);
    });
  }
}

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ['chromium','webkit'])) {
  test(`${engine}: the first scene is centered and a reload restores the reader's viewport`, async t => {
    const browser=await(engine==='webkit'?webkit.launch():chromium.launch({channel:'chromium'}));t.after(()=>browser.close());
    const context=await browser.newContext({viewport:{width:1200,height:1000}}),p=await context.newPage(),feed={q:[],closed:false};
    t.after(()=>{feed.closed=true;});p.setDefaultTimeout(5000);
    await p.addInitScript(()=>{if(!sessionStorage.getItem('seeded')){localStorage.setItem('magpie.routingStageZoom','.75');localStorage.removeItem('magpie.routingStageView');sessionStorage.setItem('seeded','1');}});
    await p.route('**/*',serve('en',feed));
    const ready=async()=>{await p.locator('.rt-req').nth(5).waitFor();await p.waitForTimeout(500);};
    const view=()=>p.locator('.rt-canvas').evaluate(c=>{const s=c.querySelector('.rt-stage'),a=c.getBoundingClientRect(),b=s.getBoundingClientRect();return {x:b.x-a.x,y:b.y-a.y,w:b.width,h:b.height,cw:c.clientWidth,ch:c.clientHeight,label:document.querySelector('.rt-zoom-at').textContent};});
    await p.goto('http://magpie.test/?view=routing');await ready();
    const first=await view();assert(Math.abs(first.x+first.w/2-first.cw/2)<2,'scene starts horizontally centered at saved zoom');
    assert(first.h<first.ch);assert(Math.abs(first.y+first.h/2-first.ch/2)<2,'small scene starts vertically centered');
    const c=await p.locator('.rt-canvas').boundingBox();await p.mouse.move(c.x+c.width-20,c.y+c.height-20);await p.mouse.down();await p.mouse.move(c.x+c.width-100,c.y+c.height-70,{steps:8});await p.mouse.up();await p.waitForTimeout(250);
    const moved=await view();assert(Math.abs(moved.x-first.x+80)<2&&Math.abs(moved.y-first.y+50)<2,'reader pans the whole diagram');
    await p.reload();await ready();const restored=await view();assert.equal(restored.label,'75%');assert(Math.abs(restored.x-moved.x)<2&&Math.abs(restored.y-moved.y)<2,'refresh restores both pan and zoom');
    await p.locator('.rt-zoom-at').click();await frames(p);const reset=await view();assert.equal(reset.label,'100%');assert(Math.abs(reset.x+reset.w/2-reset.cw/2)<2&&Math.abs(reset.y+reset.h/2-reset.ch/2)<2,'reset recenters the diagram');
  });
}
