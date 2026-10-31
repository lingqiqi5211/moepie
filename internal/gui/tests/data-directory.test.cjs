// Synthetic API fixtures only: directory choice, confirmation, drain/cancel,
// unreadable target, failed move and committed cleanup retry, all languages/engines.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {test} = require('node:test');
const {chromium,webkit} = require('playwright');
const assets=path.resolve(__dirname,'../assets');
const labels={en:['Original location','Beside the app','Data directory','Retry cleanup'],zh:['原始位置','程序旁','数据目录','重试清理'],'zh-TW':['原始位置','程式旁','資料目錄','重試清理'],ja:['元の場所','アプリの隣','データディレクトリ','削除を再試行'],de:['Ursprünglicher Ort','Neben der App','Datenverzeichnis','Bereinigung wiederholen']};
for(const engine of (process.env.BROWSER?[process.env.BROWSER]:['chromium','webkit'])) for(const lang of (process.env.LANGUAGES?process.env.LANGUAGES.split(','):Object.keys(labels))) for(const width of (process.env.WIDTH?[Number(process.env.WIDTH)]:[1000,440])) test(`${engine} ${lang} ${width}: two fixed places and truthful move/cleanup results`,async(t)=>{
 const browser=await(engine==='webkit'?webkit.launch():chromium.launch({channel:'chromium'}));t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height:900}});page.setDefaultTimeout(5000);
 const errors=[],calls=[];page.on('pageerror',e=>errors.push(e.message));
 let st={mode:'installed',webStays:true,places:[{mode:'installed',config:'/synthetic/home/.config/magpie',cache:'/synthetic/home/.cache/magpie',systemCache:'/synthetic/home/system-cache/magpie'},{mode:'portable',config:'/synthetic/application/data',cache:'/synthetic/application/data/cache'}]};
 await page.route('**/*',async route=>{
  const u=new URL(route.request().url()),p=u.pathname;const json=(x,status=200)=>route.fulfill({json:x,status});
  if(p==='/boot.js')return route.fulfill({contentType:'text/javascript',body:`window.bootPrefs={lang:${JSON.stringify(lang)},theme:'light',web:false};`});
  if(p==='/wails/runtime.js')return route.fulfill({contentType:'text/javascript',body:'export const Window={};'});
  if(p==='/api/data-directory')return json(st);
  if(p.startsWith('/api/data-directory/')){const action=p.split('/').pop();calls.push([action,route.request().postDataJSON()]);if(action==='start')st={...st,phase:'waiting',to:'portable'};if(action==='cancel')st={...st,phase:''};if(action==='retry')st={...st,phase:'waiting'};if(action==='dismiss'){st={...st};delete st.move;}return json(st);}
  if(p==='/api/state')return json({agents:[],profiles:[],settings:{lang,theme:'light'}});
  if(p==='/api/providers')return json({providers:[],presets:[],excluded:[],gateway:{running:true,window:true}});
  if(p==='/api/usage/quotas')return json([]);if(p==='/api/plugins')return json({plugins:[]});if(p==='/api/groups')return json({groups:[]});if(p.startsWith('/api/'))return json({});
  const file=path.join(assets,p==='/'?'index.html':p);return route.fulfill({body:await fs.readFile(file),contentType:{'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'}[path.extname(file)]});
 });
 const open=async()=>{await page.goto('http://magpie.test/?view=settings&tab=general');await page.locator('#dataDirRow:not([hidden])').waitFor();await page.locator('#dataDirSegs button').nth(1).waitFor();};
 await open();
 assert.equal(await page.locator('#dataDirRow .name').textContent(),labels[lang][2]);
 assert.deepEqual(await page.locator('#dataDirSegs button').allTextContents(),labels[lang].slice(0,2));
 assert.match(await page.locator('#dataDirSub > div').textContent(),new RegExp(labels[lang][0]));
 const paths=page.locator('#dataDirSub details');
 assert.equal(await paths.getAttribute('open'),null);
 assert.equal(await paths.locator('code').first().isVisible(),false);
 await paths.locator('summary').click();
 assert.equal(await paths.locator('code').first().isVisible(),true);
 assert.match(await paths.textContent(),/\/synthetic\/application\/data/);
 assert.match(await paths.textContent(),/\/synthetic\/home\/system-cache\/magpie/);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)<=1,'expanded paths overflow');
 await paths.locator('summary').click();
 assert.ok((await page.locator('#dataDirRow').boundingBox()).height<170,'collapsed setting is compact');
 assert.equal(await page.locator('#dataDirSegs .on').textContent(),labels[lang][0]);
 assert.equal(await page.locator('#dataDirRow input').count(),0);
 await page.locator('#dataDirSegs button').nth(1).click();let ask=page.locator('dialog.action-confirm[open]');await ask.waitFor();assert.equal(calls.length,0);assert.doesNotMatch(await ask.textContent(),/\{\w+\}/);await page.keyboard.press('Escape');await ask.waitFor({state:'detached'});assert.equal(calls.length,0);
 await page.locator('#dataDirSegs button').nth(1).click();await ask.waitFor();await ask.locator('button.primary').click();await page.waitForFunction(()=>document.querySelector('#dataDirNote button'));
 assert.deepEqual(calls[0],['start',{mode:'portable'}]);assert.equal(await page.locator('#dataDirSegs button:disabled').count(),2);await page.locator('#dataDirNote button').click();
 await page.waitForFunction(()=>!document.querySelector('#dataDirSegs button').disabled);
 st={...st,places:st.places.map(p=>p.mode==='portable'?{...p,blocked:'synthetic read-only folder'}:p)};await open();assert.equal(await page.locator('#dataDirSegs button').nth(1).isDisabled(),true);assert.match(await page.locator('#dataDirSegs button').nth(1).getAttribute('title'),/synthetic read-only/);
 st={...st,mode:'portable',move:{state:'cleanup',error:'synthetic locked old file'},places:st.places.map(p=>({...p,blocked:''}))};await open();assert.equal(await page.locator('#dataDirSegs .on').textContent(),labels[lang][1]);assert.equal(await page.locator('#dataDirNote button').textContent(),labels[lang][3]);assert.match(await page.locator('#dataDirNote').textContent(),/synthetic locked old file/);assert.equal(await page.locator('#dataDirSegs button:disabled').count(),2);await page.locator('#dataDirNote button').click();assert.equal(calls.at(-1)[0],'retry');
 st={...st,phase:'',move:{state:'failed',error:'synthetic verification failed'}};await open();assert.match(await page.locator('#dataDirNote').textContent(),/synthetic verification failed/);assert.equal(await page.locator('#dataDirNote button').count(),2);
 const errorDetails=page.locator('#dataDirNote details');
 assert.equal(await errorDetails.getAttribute('open'),null);
 assert.equal(await errorDetails.locator('div').isVisible(),false);
 await errorDetails.locator('summary').focus();await page.keyboard.press('Enter');
 assert.equal(await errorDetails.locator('div').isVisible(),true);
 st={...st,move:{state:'complete'}};await open();assert.equal(await page.locator('#dataDirNote button').count(),1);assert.doesNotMatch(await page.locator('#dataDirNote').textContent(),/\{\w+\}/);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)<=1,'horizontal overflow');assert.deepEqual(errors,[]);
});
