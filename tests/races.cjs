// Isolated local HTTP origin and synthetic API only. Never forwards requests to GAS.
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const root = process.env.APP_ROOT || path.resolve(__dirname,'..');
const server = http.createServer((req,res)=>{
 const f=path.join(root,decodeURIComponent(req.url.split('?')[0]==='/'?'/index.html':req.url.split('?')[0]));
 if (!f.startsWith(root+'/')) {res.writeHead(403).end();return;}
 fs.readFile(f,(e,b)=>{if(e){res.writeHead(404).end();return;} res.setHeader('Content-Type',f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html');res.end(b);});
});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const items=[{id:'count',label:'試験累計',type:'cumulative',icon:'⭐',unit:'件'},{id:'n',label:'試験数値',type:'integer',icon:'⭐',unit:'件'},{id:'t',label:'試験時刻',type:'time',icon:'⭐',unit:''}];
let browser, failures=0;
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 async function scenario(name,fn){let ctx;try{
 ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});
 const page=await ctx.newPage();page.setDefaultTimeout(5000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let opts={getDelay:600,postDelay:0,offline:false},values={count:100},days={},posts=[],gets=[];
 await ctx.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());
 if(url.origin===base)return route.continue();
 if(url.hostname!=='script.google.com')return route.abort();
 if(opts.offline)return route.abort();
 const data=req.method()==='POST'?JSON.parse(req.postData()):Object.fromEntries(url.searchParams);
 if(req.method()==='POST'){
 posts.push(data);await delay(opts.postDelay);
 if(opts.failPosts)return route.fulfill({json:{ok:false,error:"synthetic offline"},headers:{"Access-Control-Allow-Origin":"*"}});
 if(data.type==='habit_day_upsert'){Object.assign(values,data.set);for(const k of data.del)delete values[k];}
 if(data.type==='meal_day_upsert')days[data.date]={...days[data.date],...data.set};
 return route.fulfill({json:{ok:true,data:{}},headers:{'Access-Control-Allow-Origin':'*'}});
 }
 gets.push(data.type); const snapshot=JSON.parse(JSON.stringify({items,values,days,tasks:[],entries:[],events:[]}));await delay(opts.getDelay);
 return route.fulfill({json:{ok:true,data:snapshot},headers:{'Access-Control-Allow-Origin':'*'}});
 });
 await page.addInitScript(({items})=>{localStorage.setItem('sth_v3_active_tab','habit');localStorage.setItem('sth_v3_habit_items',JSON.stringify(items));},{items});
 await page.goto(base);await page.locator('[data-id="count"]').waitFor();
 await fn({page,opts,values,days,posts,gets,base});assert.deepEqual(errors,[]);console.log('PASS',name);
 }catch(e){failures++;console.log('FAIL',name,e.message);}finally{await ctx?.close();}}
 await scenario('late habit response cannot overwrite any other tab',async({page})=>{
 for(const tab of ['meal','task','daily','memo']){await page.click('[data-tab="habit"]');await delay(50);await page.click(`[data-tab="${tab}"]`);await delay(750);assert.equal(await page.locator(`#tab-content .${tab}-tab`).count(),1,tab);assert.equal(await page.locator('#tab-content .habit-tab').count(),0,tab);}
 });
 await scenario('focused input and keyboard survive delayed sync',async({page})=>{
 const input=page.locator('[data-id="n"] input');await input.fill('123');await delay(850);assert.equal(await input.inputValue(),'123');assert(await input.evaluate(e=>e===document.activeElement));
 });
 await scenario('cumulative input not cleared by timer or repeated tap',async({page,opts})=>{
 await delay(800);opts.getDelay=0;const input=page.locator('[data-id="count"] input');await input.focus();await input.fill('7');await delay(180);assert.equal(await input.inputValue(),'7');await input.dispatchEvent('pointerup');assert.equal(await input.inputValue(),'7');await input.blur();assert.equal(await input.inputValue(),'107');
 });
 await scenario('stale response does not erase committed total even after POST completed',async({page,opts,values})=>{
 await delay(800);opts.getDelay=800;await page.click('[data-tab="habit"]');await delay(70);const input=page.locator('[data-id="count"] input');await input.focus();await input.fill('7');await input.blur();await delay(1100);assert.equal(await input.inputValue(),'107');assert.equal(values.count,107);
 });
 await scenario('late response from another tab does not cancel meal time editing',async({page})=>{
 await page.click('[data-tab="meal"]');await page.click('.meal-cell[data-date]');const input=page.locator('.meal-time').first();await input.focus();await input.fill('12:30');await delay(850);assert.equal(await input.inputValue(),'12:30');assert(await input.evaluate(e=>e===document.activeElement));
 });
 await scenario('offline habit/meal queued and replayed, no full-day overwrite',async({page,opts,posts,base})=>{
 await delay(800);opts.offline=true;const input=page.locator('[data-id="count"] input');await input.focus();await input.fill('3');await input.blur();await delay(200);await page.click('[data-tab="meal"]');await page.click('.meal-cell[data-date]');await page.locator('.meal-text').first().fill('試験のみ');await delay(250);
 const count=await page.evaluate(async()=> (await import('/js/outbox.js')).count());assert(count>=2,'queue saved immediately');opts.offline=false;await page.evaluate(async()=> (await import('/js/sync.js')).flushAll());assert.equal(await page.evaluate(async()=> (await import('/js/outbox.js')).count()),0);assert(posts.some(x=>x.type==='habit_day_upsert'&&x.set.count===103));assert(posts.some(x=>x.type==='meal_day_upsert'&&Object.keys(x.set).length===1));
 });

 await scenario('quick leave/re-enter and late manual refresh cannot replace current view',async({page,opts})=>{
 await delay(800);opts.getDelay=400;
 await page.click('#btn-refresh');await page.click('[data-tab="meal"]');await page.click('#btn-refresh');await page.click('[data-tab="memo"]');await delay(650);
 assert.equal(await page.locator('#tab-content .memo-tab').count(),1);
 for(const tab of ['habit','meal','daily','task','memo','habit']){await page.click(`[data-tab="${tab}"]`);}
 const input=page.locator('[data-id="n"] input');await input.fill('91');await delay(700);assert.equal(await input.inputValue(),'91');
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT,fullPage:true});
 });
 await scenario('cumulative sequential + zero + negative edits retain total',async({page,opts,values})=>{
 await delay(800);opts.postDelay=200;const input=page.locator('[data-id="count"] input');
 for(const n of ['4','0','-2']){await input.focus();await input.fill(n);await input.blur();}
 await delay(1200);assert.equal(await input.inputValue(),'102');assert.equal(values.count,102);
 });
 await scenario('failed merged queue retains order when newer edits arrive in flight',async({page,opts,posts,values})=>{
 await delay(800);opts.failPosts=true;opts.postDelay=250;
 await page.evaluate(async()=>{const o=await import('/js/outbox.js');for(const n of [1,2])await o.enqueue({type:'habit_day_upsert',payload:{date:'2000-01-01',set:{count:n},del:[]}});window.testFlush=(await import('/js/sync.js')).flushAll();});
 await delay(80);assert(posts.length>0);
 await page.evaluate(async()=>{const o=await import('/js/outbox.js');await o.enqueue({type:'habit_day_upsert',payload:{date:'2000-01-01',set:{count:3},del:[]}});});
 await page.evaluate(()=>window.testFlush);
 const rows=await page.evaluate(async()=> (await import('/js/outbox.js')).listAll());assert.deepEqual(rows.map(x=>x.op.payload.set.count),[2,3]);
 opts.failPosts=false;opts.postDelay=0;await page.evaluate(async()=> (await import('/js/sync.js')).flushAll());assert.equal(values.count,3);
 });

 await browser.close();server.close();process.exitCode=failures?1:0;
})().catch(async e=>{console.error(e);await browser?.close();server.close();process.exitCode=1;});
