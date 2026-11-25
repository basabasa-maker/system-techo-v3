// Isolated browser + synthetic GAS only. Never accesses HealthKit or production data.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const root=process.env.APP_ROOT||path.resolve(__dirname,'..'),clone=x=>JSON.parse(JSON.stringify(x)),delay=ms=>new Promise(r=>setTimeout(r,ms));
const TODAY='2027-01-01',PREV='2026-12-31',NEXT='2027-01-02',PAIR_KEY='a'.repeat(43);
const SETTINGS='sth_v3_health_settings',PENDING='sth_v3_health_pending';
const items=[
 {id:'weight',label:'体重',type:'decimal',icon:'•',unit:'kg'},
 {id:'bodyFat',label:'体脂肪率',type:'decimal',icon:'•',unit:'%'},
 {id:'kcal',label:'消費カロリー',type:'integer',icon:'•',unit:'kcal'},
 {id:'steps',label:'歩数',type:'integer',icon:'•',unit:'歩'},
 {id:'water',label:'水分',type:'integer',icon:'•',unit:'ml'},
 {id:'lastMeal',label:'前日の最終食事',type:'time',icon:'•',unit:''},
];
const initialValues={
 [TODAY]:{weight:61.5,bodyFat:20.1,kcal:200,steps:1234,water:500,lastMeal:'18:15',future:{zero:0,keep:false}},
 [PREV]:{weight:59,bodyFat:19.2,kcal:700,steps:9000,unknown:'previous'},
 [NEXT]:{weight:63,kcal:100,steps:500,unknown:'next'},
};
const initialDays={ [PREV]:{朝:{time:'',text:'時刻のない朝食'},unknown:{keep:true}}, [TODAY]:{夕:{time:'',text:'当日の記録'}} };
const headers={'Access-Control-Allow-Origin':'*'};
const server=http.createServer((req,res)=>{
 const rel=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(root,'.'+(rel==='/'?'/index.html':rel));
 if(!file.startsWith(root+path.sep))return res.writeHead(403).end();
 fs.readFile(file,(e,b)=>{if(e)return res.writeHead(404).end();res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.json':'application/json','.zip':'application/zip','.png':'image/png','.jpg':'image/jpeg'})[path.extname(file)]||'text/html');res.end(b);});
});
let browser,base,passed=0,failed=0;
async function until(check,message,timeout=7000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(30);}assert.fail(message);}
const field=(page,key)=>page.locator(`[data-id="${key}"] input`);
const healthReads=posts=>posts.filter(p=>p.type==='health_bridge_read');
const habitWrites=posts=>posts.filter(p=>p.type==='habit_day_upsert');
const metricWrites=posts=>habitWrites(posts).filter(p=>Object.keys(p.set||{}).some(key=>['bodyFat','kcal','steps'].includes(key)));
async function pending(page){return page.evaluate(key=>JSON.parse(localStorage.getItem(key)||'null'),PENDING);}
async function begin(page,posts){
 assert.equal(await page.evaluate(()=>!!window.navigation),true,'test browser must support cancelling external protocol navigation');
 await page.locator('#btn-refresh').click();await until(async()=>!!await pending(page),'manual refresh must create a pending Health request');
 const request=await pending(page),launches=await page.evaluate(()=>window.testShortcutLaunches);
 assert(launches.length>0,'native Shortcut launch is captured and cancelled at the test OS boundary');
 const url=new URL(launches.at(-1)),input=JSON.parse(url.searchParams.get('text'));
 assert.equal(url.protocol,'shortcuts:');assert.deepEqual(Object.keys(input).sort(),['date','issued_at','request_id']);
 assert.equal(input.request_id,request.request_id);assert.equal(input.date,TODAY);assert(!launches.at(-1).includes(PAIR_KEY));
 await until(()=>Promise.resolve(healthReads(posts).length>0),'Health result polling starts');return request;
}
async function openHealthTools(page){
 const disclosure=page.locator('#health-disclosure');
 if(!await disclosure.evaluate(el=>el.open))await disclosure.locator('summary').click();
}
async function openHealthSettings(page){await openHealthTools(page);await page.locator('#h-health-setup').click();}
async function done(page,posts){await until(async()=>!await pending(page),'Health import finishes');await until(()=>Promise.resolve(posts.some(p=>p.type==='health_bridge_ack')),'temporary result acknowledged');}
async function scenario(name,fn,{enabled=true,verified=true}={}){
 if(process.env.HEALTH_TEST&&!name.includes(process.env.HEALTH_TEST))return;
 let ctx,page;
 try{
  ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});
  page=await ctx.newPage();page.setDefaultTimeout(4000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const values=clone(initialValues),days=clone(initialDays),posts=[],gets=[];
  const opts={healthStatus:'ready',readDelay:0,healthValues:{weight:62.3,bodyFat:21.2,kcal:420,steps:8040},healthUnits:{weight:'kg',bodyFat:'%',kcal:'kcal',steps:'count'},resultDate:null,failPosts:false,habitPostDelay:0,habitGetDelay:0,items:clone(items)};
  await ctx.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.origin===base)return route.continue();
   if(url.protocol==='shortcuts:')return route.abort();
   if(url.hostname!=='script.google.com')return route.abort();
   const p=req.method()==='POST'?JSON.parse(req.postData()):Object.fromEntries(url.searchParams);
   if(String(p.type||'').startsWith('health_bridge_')){
    assert.equal(req.method(),'POST','Health bridge credentials are sent in a POST body');
    assert(!url.href.includes(PAIR_KEY),'pairing key never appears in the request URL');
    assert.match(p.request_id,/^[A-Za-z0-9_-]{43}$/);assert.equal(p.pair_key,PAIR_KEY);
   }
   if(req.method()==='POST'){
    posts.push(clone(p));
    if(p.type==='health_bridge_read'){
     const data=opts.healthStatus==='ready'?{status:'ready',date:opts.resultDate||p.date,issued_at:p.issued_at,values:clone(opts.healthValues),units:clone(opts.healthUnits)}:{status:opts.healthStatus,date:p.date,issued_at:p.issued_at};
     await delay(opts.readDelay);return route.fulfill({json:{ok:true,data},headers});
    }
    if(p.type==='health_bridge_ack')return route.fulfill({json:{ok:true,data:{status:'consumed',date:p.date,issued_at:p.issued_at}},headers});
    if(p.type==='habit_day_upsert')await delay(opts.habitPostDelay);
    if(opts.failPosts)return route.fulfill({json:{ok:false,error:'synthetic save failure'},headers});
    if(p.type==='habit_day_upsert'){values[p.date]||={};Object.assign(values[p.date],p.set);for(const key of p.del||[])delete values[p.date][key];}
    if(p.type==='meal_day_upsert')days[p.date]={...days[p.date],...p.set};
    return route.fulfill({json:{ok:true,data:{}},headers});
   }
   gets.push(clone(p));let data={tasks:[],entries:[],events:[],items:[],values:{},days:{}};
   if(p.type==='habit_items')data={items:clone(opts.items)};
   else if(p.type==='habit_day')data={values:clone(values[p.date]||{})};
   else if(p.type==='habit_range')data={days:clone(values)};
   else if(p.type==='meal_month')data={days:clone(Object.fromEntries(Object.entries(days).filter(([date])=>date.startsWith(p.month+'-'))))};
   if(p.type==='habit_day')await delay(opts.habitGetDelay);
   return route.fulfill({json:{ok:true,data},headers});
  });
  await page.clock.setFixedTime(new Date('2027-01-01T12:00:00'));
  await page.addInitScript(({values,days,items,enabled,verified,key,settingsKey})=>{
   // Stub the OS handoff boundary only; never launch the host's actual Shortcuts app.
   window.testShortcutLaunches=[];
   window.navigation?.addEventListener('navigate',event=>{
    if(event.destination.url.startsWith('shortcuts:')){
     window.testShortcutLaunches.push(event.destination.url);event.preventDefault();
    }
   });
   if(localStorage.getItem('health-test:seeded'))return;
   localStorage.setItem('health-test:seeded','1');localStorage.setItem('sth_v3_cache_schema','4');localStorage.setItem('sth_v3_active_tab','habit');localStorage.setItem('sth_v3_habit_items',JSON.stringify(items));
   for(const [date,value]of Object.entries(values))localStorage.setItem('sth_v3_habitday_'+date,JSON.stringify(value));
   for(const [date,value]of Object.entries(days))localStorage.setItem('sth_v3_mealday_'+date,JSON.stringify(value));
   localStorage.setItem('preserve:health-test',' { "unchanged":[0,false] } ');
   if(enabled)localStorage.setItem(settingsKey,JSON.stringify({enabled:true,shortcutName:'システム手帳 ヘルスケア同期',pairKey:key,verifiedKeys:verified?['weight','bodyFat','kcal','steps']:[]}));
  },{values:clone(values),days:clone(days),items,enabled,verified,key:PAIR_KEY,settingsKey:SETTINGS});
  await page.goto(base);await field(page,'weight').waitFor();await until(()=>Promise.resolve(gets.some(p=>p.type==='habit_day')),'initial habit data');await delay(100);
  await fn({page,values,days,opts,posts,gets});
  assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>localStorage.getItem('preserve:health-test')),' { "unchanged":[0,false] } ');
  assert.deepEqual(values[PREV],initialValues[PREV],'previous date remains unchanged');assert.deepEqual(values[NEXT],initialValues[NEXT],'next date remains unchanged');assert.deepEqual(days,initialDays,'all meal records remain unchanged');
  passed++;console.log('PASS '+name);
 }catch(e){failed++;console.log('FAIL '+name+': '+e.message);if(process.env.HEALTH_DIAGNOSTICS&&page){console.log('DIAG',await page.evaluate(()=>({status:document.querySelector('#health-status')?.textContent,modals:Array.from(document.querySelectorAll('.health-modal')).map(e=>e.textContent),pending:!!localStorage.getItem('sth_v3_health_pending'),verified:JSON.parse(localStorage.getItem('sth_v3_health_settings')||'{}').verifiedKeys,visibility:document.visibilityState,hasFocus:document.hasFocus(),launches:window.testShortcutLaunches?.length,active:document.activeElement?.outerHTML.slice(0,180)})));}}finally{await ctx?.close();}
}
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 await scenario('Health controls start folded and keep their disclosure state without changing records',async({page,posts,values})=>{
  const disclosure=page.locator('#health-disclosure'),summary=disclosure.locator('summary');
  assert.equal(await disclosure.count(),1,'Health controls have a disclosure');
  assert.equal(await disclosure.evaluate(el=>el.open),false,'closed by default');
  assert.equal(await summary.isVisible(),true);assert.equal(await page.locator('#h-health-setup').isVisible(),false);
  assert.equal(await page.locator('#health-status').isVisible(),false,'routine status is hidden');
  const closed=await disclosure.boundingBox();
  if(process.env.HEALTH_COLLAPSED_SCREENSHOT)await page.screenshot({path:process.env.HEALTH_COLLAPSED_SCREENSHOT});
  await summary.press('Space');await until(()=>disclosure.evaluate(el=>el.open),'keyboard opens disclosure');
  assert.equal(await page.locator('#h-health-setup').isVisible(),true);
  const expanded=await disclosure.boundingBox();assert(expanded.height>closed.height,'only opened details occupy extra height');
  assert(closed.x>=0&&closed.x+closed.width<=390,'disclosure fits mobile viewport');
  if(process.env.HEALTH_EXPANDED_SCREENSHOT)await page.screenshot({path:process.env.HEALTH_EXPANDED_SCREENSHOT});
  await page.locator('#btn-refresh').click();await delay(300);
  assert.equal(await disclosure.evaluate(el=>el.open),true,'normal refresh preserves open choice');
  await summary.click();await until(async()=>!await disclosure.evaluate(el=>el.open),'disclosure closes');
  await page.locator('#btn-refresh').click();await delay(300);
  assert.equal(await disclosure.evaluate(el=>el.open),false,'normal refresh keeps controls folded');
  await page.reload();await field(page,'weight').waitFor();
  assert.equal(await disclosure.evaluate(el=>el.open),false,'new page starts folded');
  assert.equal(healthReads(posts).length,0);assert.equal(habitWrites(posts).length,0);assert.deepEqual(values,initialValues);
  console.log('Disclosure mobile heights: '+closed.height+' closed / '+expanded.height+' open');
 },{enabled:false});
 await scenario('setup downloads a ZIP containing the signed shortcut without navigating away',async({page,posts,values})=>{
  await openHealthSettings(page);
  const footer=await page.locator('#health-save').boundingBox();
  assert(footer&&footer.y>=0&&footer.y+footer.height<=844,'save button stays inside the mobile viewport');
  const body=page.locator('.health-modal .modal-body');
  assert.equal(await body.evaluate(el=>el.scrollHeight>el.clientHeight),true,'long instructions scroll inside the dialog');
  if(process.env.HEALTH_SETUP_SCREENSHOT)await page.screenshot({path:process.env.HEALTH_SETUP_SCREENSHOT});
  const link=page.locator('.health-setup-steps a[download]');
  assert.equal(await link.getAttribute('href'),'shortcuts/health-bridge/system-techo-health.zip');
  const [download]=await Promise.all([page.waitForEvent('download'),link.click()]);
  assert.equal(download.suggestedFilename(),'system-techo-health.zip');
  assert.equal(await download.failure(),null);
  const bytes=fs.readFileSync(await download.path());
  assert.deepEqual(bytes,fs.readFileSync(path.join(root,'shortcuts/health-bridge/system-techo-health.zip')));
  assert.equal(await page.locator('#health-save').isVisible(),true,'download keeps setup open');
  assert.equal(healthReads(posts).length,0);assert.equal(habitWrites(posts).length,0);assert.deepEqual(values,initialValues);
 },{enabled:false});
 await scenario('settings enable Health import and only requested fields on the selected day change',async({page,values,posts})=>{
  assert.equal(healthReads(posts).length,0,'launch does not query Health');
  await openHealthSettings(page);await page.locator('#health-enabled').check();
  await page.locator('#health-shortcut-name').fill('システム手帳 ヘルスケア同期');await page.locator('#health-pair-key').fill(PAIR_KEY);await page.locator('#health-save').click();
  assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).enabled,SETTINGS),true);
  await begin(page,posts);
  await page.locator('#health-confirm').waitFor();
  assert.equal(habitWrites(posts).length,0,'initial Health values are not saved before approval');
  const preview=process.env.HEALTH_PREVIEW_SCREENSHOT;
  if(preview){await until(async()=>(await page.locator('.toast').count())===0,'setup notification clears before preview image',5000);fs.mkdirSync(path.dirname(preview),{recursive:true});await page.screenshot({path:preview,fullPage:true});}
  await page.locator('#health-confirm').click();await done(page,posts);
  assert.deepEqual(metricWrites(posts).map(p=>({date:p.date,set:p.set,del:p.del})),[{date:TODAY,set:{weight:62.3,bodyFat:21.2,kcal:420,steps:8040},del:[]}]);
  assert.deepEqual(values[TODAY],{...initialValues[TODAY],weight:62.3,bodyFat:21.2,kcal:420,steps:8040});
  assert.equal(await field(page,'weight').inputValue(),'62.3');assert.equal(await field(page,'steps').inputValue(),'8040');
  assert.deepEqual(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).verifiedKeys.sort(),SETTINGS),['bodyFat','kcal','steps','weight']);
  await until(async()=>(await page.locator('#health-status').textContent()).includes('取り込みました'),'completed import is announced');
  const shot=process.env.HEALTH_SCREENSHOT;
  if(shot){await until(async()=>(await page.locator('.toast').count())===0,'transient messages clear for review',5000);fs.mkdirSync(path.dirname(shot),{recursive:true});await page.screenshot({path:shot,fullPage:true});}
 },{enabled:false});
 await scenario('rejecting first unverified measurements preserves all saved data',async({page,posts,values})=>{
  await begin(page,posts);await page.locator('#health-reject').waitFor();
  assert.equal(habitWrites(posts).length,0,'unverified result waits for user decision');
  await page.locator('#health-reject').click();await until(async()=>!await pending(page),'rejected import is cancelled');
  await delay(200);assert.equal(habitWrites(posts).length,0);assert.deepEqual(values,initialValues);
 },{verified:false});
 await scenario('draft pairing key survives reload before setup is saved without enabling Health',async({page,posts,values})=>{
  await openHealthSettings(page);
  const first=await page.locator('#health-pair-key').inputValue();
  assert.equal(/^[A-Za-z0-9_-]{43}$/.test(first),true,'setup generates a valid local pairing key');
  assert.equal(await page.locator('#health-enabled').isChecked(),false);
  await page.reload();await field(page,'weight').waitFor();await openHealthSettings(page);
  const second=await page.locator('#health-pair-key').inputValue();
  assert.equal(first===second,true,'unsaved initial key must survive the iPhone setup handoff');
  assert.equal(await page.locator('#health-enabled').isChecked(),false,'persisting a draft key does not enable Health');
  await page.locator('#health-enabled').check();await page.locator('#health-save').click();
  await openHealthSettings(page);await page.locator('#health-renew-key').click();
  assert.equal(first===(await page.locator('#health-pair-key').inputValue()),false,'renew changes the form draft');
  await page.reload();await field(page,'weight').waitFor();await openHealthSettings(page);
  assert.equal(first===(await page.locator('#health-pair-key').inputValue()),true,'unsaved renewal must not replace a saved pairing key');
  assert.equal(await page.locator('#health-enabled').isChecked(),true,'existing enabled setting remains saved');
  assert.equal(healthReads(posts).length,0);assert.equal(habitWrites(posts).length,0);assert.deepEqual(values,initialValues);
 },{enabled:false});
 await scenario('disabled by default and still disabled after reload does not query Health',async({page,posts})=>{
  await page.locator('#btn-refresh').click();await delay(300);assert.equal(healthReads(posts).length,0);assert.equal(await pending(page),null);
  await page.reload();await field(page,'weight').waitFor();await delay(200);assert.equal(healthReads(posts).length,0);
 },{enabled:false});
 await scenario('missing metrics are preserved while genuine zero values are imported',async({page,opts,posts,values})=>{
  opts.healthValues={weight:62.3,kcal:0,steps:0};opts.healthUnits={weight:'kg',kcal:'kcal',steps:'count'};
  await begin(page,posts);await done(page,posts);
  assert.deepEqual(metricWrites(posts).map(p=>p.set),[{weight:62.3,kcal:0,steps:0}]);
  assert.equal(values[TODAY].bodyFat,20.1);assert.equal(values[TODAY].steps,0);assert.equal(values[TODAY].kcal,0);
 });
 await scenario('no samples never writes zeros, previous values or an empty replacement day',async({page,opts,posts,values})=>{
  opts.healthValues={};opts.healthUnits={};await begin(page,posts);await done(page,posts);
  assert.deepEqual(values,initialValues);assert.equal(habitWrites(posts).length,0);
 });
 for(const invalid of ['day','unit'])await scenario('invalid Health '+invalid+' cannot mutate any saved habit',async({page,opts,posts,values})=>{
  if(invalid==='day')opts.resultDate=PREV;else opts.healthUnits.steps='kg';
  await begin(page,posts);await delay(500);assert.equal(habitWrites(posts).length,0);assert.deepEqual(values,initialValues);
 });
 await scenario('manual edits after launch win even when changed back to the original value',async({page,opts,posts,values})=>{
  opts.readDelay=650;await begin(page,posts);
  const input=field(page,'weight');await input.fill('63.8');await input.blur();await input.fill('61.5');await input.blur();
  await done(page,posts);assert.equal(values[TODAY].weight,61.5);assert.equal(await input.inputValue(),'61.5');
  assert(!habitWrites(posts).some(p=>p.set?.weight===62.3),'Health must not undo an explicitly edited field');
  assert.deepEqual(metricWrites(posts).map(p=>p.set),[{bodyFat:21.2,kcal:420,steps:8040}]);
 });
 await scenario('late Health result does not write while another date is displayed',async({page,opts,posts,values})=>{
  opts.readDelay=600;await begin(page,posts);await page.locator('#h-next').press('Enter');await delay(900);
  assert.equal(habitWrites(posts).length,0);assert.deepEqual(values,initialValues);
 });
 await scenario('late Health result does not write over another tab',async({page,opts,posts,values})=>{
  opts.readDelay=600;await begin(page,posts);await page.locator('[data-tab="task"]').press('Enter');await delay(900);
  assert.equal(await page.locator('.task-tab').count(),1);assert.equal(habitWrites(posts).length,0);assert.deepEqual(values,initialValues);
 });
 await scenario('disabling pairing cancels a waiting import and ignores its later result',async({page,opts,posts,values})=>{
  opts.healthStatus='waiting';await begin(page,posts);await openHealthSettings(page);await page.locator('#health-enabled').uncheck();await page.locator('#health-save').click();
  assert.equal(await pending(page),null);opts.healthStatus='ready';await page.evaluate(()=>window.dispatchEvent(new Event('pageshow')));await delay(1700);
  assert.equal(habitWrites(posts).length,0);assert.deepEqual(values,initialValues);
 });
 await scenario('Health request expiring during normal refresh cannot enter the save queue',async({page,opts,posts,gets,values})=>{
  const initialReads=gets.filter(p=>p.type==='habit_day').length;opts.habitGetDelay=600;
  await begin(page,posts);await until(()=>Promise.resolve(gets.filter(p=>p.type==='habit_day').length>initialReads),'normal habit refresh begins after ready Health result');
  const time=await page.evaluate(()=>Date.now());await page.clock.setFixedTime(new Date(time+600001));
  await delay(1100);
  assert.equal(metricWrites(posts).length,0,'an expired Health result must not enqueue a patch after awaited normal refresh');
  assert.deepEqual(values,initialValues);
 });
 await scenario('save in progress prevents misleading cancel or settings changes',async({page,opts,posts})=>{
  opts.habitPostDelay=500;await begin(page,posts);
  await until(()=>Promise.resolve(metricWrites(posts).length===1),'Health save request begins');
  assert.equal(await page.locator('#h-health-cancel').isDisabled(),true,'cannot cancel after durable saving has begun');
  assert.equal(await page.locator('#h-health-setup').isDisabled(),true,'cannot change pairing while saving');
  await done(page,posts);await until(()=>page.locator('#h-health-setup').isEnabled(),'settings re-enabled after save');
  assert.equal(metricWrites(posts).length,1,'one Health result saves once');
 });
 await scenario('failed pending edits are not replaced by fresh Health values',async({page,opts,posts,values})=>{
  opts.failPosts=true;opts.healthValues={weight:62.3};opts.healthUnits={weight:'kg'};const input=field(page,'weight');await input.fill('64');await input.blur();await delay(150);
  await begin(page,posts);await delay(700);
  assert(!habitWrites(posts).some(p=>p.set?.weight===62.3),'Health cannot replace an unsent manual field');assert.equal(await input.inputValue(),'64');
  const queue=await page.evaluate(async()=>(await import('/js/outbox.js')).listAll());
  assert.equal(queue.length,1,'existing pending edit is retained');assert.equal(queue[0].op.payload.set.weight,64);
  assert.equal(values[TODAY].weight,61.5,'synthetic server was not overwritten');
 });
 await browser.close();await new Promise(r=>server.close(r));console.log('Health browser checks: '+passed+' passed, '+failed+' failed');process.exitCode=failed?1:0;
})().catch(async e=>{console.error(e);await browser?.close();server.close();process.exitCode=1;});
