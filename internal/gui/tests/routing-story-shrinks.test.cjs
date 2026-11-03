// Run with Node's test runner and Playwright on the module path.
// Design B owns the summary. Diagnostics are opt-in, and neither an older
// request nor an expanded disclosure reserves blank space for the next one.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { chromium, webkit } = require('playwright');
const assets = path.resolve(__dirname, '../assets');
const now = Date.now();
const iso = ms => new Date(ms).toISOString();
const seat = n => ({ id: 'codex@me' + n, provider: 'codex', name: 'ChatGPT ' + n, who: 'me' + n + '@example.com', kind: 'account', model: 'gpt-6.1-sol', known: true, plan: 'Pro' });
function req(id, hops, done = true) {
  const t0 = now - (200 - id) * 1000;
  const order = Array.from({length: hops + 1}, (_, i) => seat(i));
  const tries = order.map((s, i) => i < hops
    ? { id: s.id, model: s.model, start: iso(t0 + i * 100), done: true, status: 429, ms: 90, error: 'rate limited: try again in 30s' }
    : { id: s.id, model: s.model, start: iso(t0 + i * 100), done, ...(done ? { status: 200, ms: 4000 } : {}) });
  return { id, seq: id * 10 + (done ? 2 : 0), time: iso(t0), agent: 'codex', session: '019a-session', model: 'gpt-6.1-sol', provider: 'codex', order, tries, done,
    ...(done ? { status: 200, ms: 4000 + hops * 100, tokens: 2000, usage: [{ in: 3000, cache_read: 87000, out: 400 }] } : {}) };
}
function serve(lang, feed) {
  return async route => {
    const u = new URL(route.request().url()), json = data => route.fulfill({json: data});
    if (u.pathname === '/boot.js') return route.fulfill({contentType:'text/javascript', body: `window.bootPrefs={lang:'${lang}',theme:'light',web:true};`});
    if (u.pathname === '/wails/runtime.js') return route.fulfill({contentType:'text/javascript',body:'export const Window = {};'});
    if (u.pathname === '/api/state') return json({agents:[{id:'codex',name:'Codex',path:'/test/codex',fields:[]}],profiles:[],settings:{lang,theme:'light'}});
    if (u.pathname === '/api/gateway/trace') {
      const rs = u.searchParams.get('wait') ? [].concat(await new Promise(r => {feed.next = r;})) : [req(101,0),req(102,0)];
      return json({mine:true,now:iso(Date.now()),seq:rs.at(-1).seq,totals:{requests:0,rerouted:0,errors:0},routes:rs});
    }
    if (u.pathname === '/api/gateway/history') return json({cut:false,days:[],routes:[]});
    if (u.pathname === '/api/groups') return json({groups:[],models:[],pools:[]});
    if (u.pathname === '/api/providers') return json({providers:[],presets:[],excluded:[],gateway:{running:true,window:true,url:'http://127.0.0.1:3999'}});
    if (u.pathname.startsWith('/api/')) return json({});
    const file = path.join(assets,u.pathname === '/' ? 'index.html' : u.pathname);
    return route.fulfill({body:await fs.readFile(file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'}[path.extname(file)]});
  };
}
for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ['chromium','webkit'])) {
  for (const [lang,width] of [['en',1100],['zh',420]]) {
    test(`${engine} ${lang}: compact summary never inherits an older request's empty height`, async t => {
      const b = await (engine === 'webkit' ? webkit.launch() : chromium.launch({channel:'chromium'}));
      t.after(() => b.close());
      const p = await b.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
      p.setDefaultTimeout(5000);
      const errors=[];p.on('pageerror',e=>errors.push(e.message));
      const feed={next:null};await p.route('**/*',serve(lang,feed));
      await p.goto('http://magpie.test/?view=routing');await p.locator('.rt-selected').waitFor();
      const send=async r=>{for(let i=0;i<60&&!feed.next;i++)await p.waitForTimeout(50);assert(feed.next,'trace subscription');const next=feed.next;feed.next=null;next(r);await p.waitForTimeout(200);};
      const compact=async()=>{
        const x=await p.locator('.rt-log').evaluate(e=>{const r=e.querySelector('.rt-route'),a=r.querySelector('.rt-analysis'),d=e.querySelector('.rt-diag');return {routeHeld:r.style.minHeight,diagHeld:d.style.minHeight,open:d.open,gap:e.querySelector('.rt-result').getBoundingClientRect().top-a.getBoundingClientRect().bottom};});
        assert.equal(x.open,false,'even running/retried requests keep diagnostics folded until asked');
        assert.equal(x.routeHeld,'','the summary uses the current content height');
        assert.equal(x.diagHeld,'','a closed disclosure has no inherited height');
        assert(x.gap<20,`no reserved space below the analysis: ${JSON.stringify(x)}`);
      };
      await compact();
      await send(req(103,4));await compact();
      await p.locator('.rt-diag > summary').dispatchEvent('click');
      assert(await p.locator('.rt-diag').evaluate(e=>e.open));
      await send(req(104,0,false));await compact();
      await send(req(104,0));await compact();
      await p.locator('.rt-diag > summary').dispatchEvent('click');
      const update=req(104,0);update.seq++;update.ms++;
      await send(update);assert(await p.locator('.rt-diag').evaluate(e=>e.open),'user expansion survives updates of the same request');
      for(let id=105;id<108;id++){await send([req(id-1,0),req(id,0,false)]);await compact();}
      assert.deepEqual(errors,[]);
      feed.next?.(req(999,0));
    });
  }
}
