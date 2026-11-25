// Real Service Worker lifecycle, localhost only, synthetic records and intercepted APIs.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const root=process.env.APP_ROOT||path.resolve(__dirname,'..');
const BUILDS=['20270101-010101','20270101-010102','20270101-010103'];
// Optional one-case migration check reads the actual previous worker from local Git.
const legacyMode=process.env.UPDATE_SW_LEGACY==='1';
const legacyWorker=legacyMode?require('node:child_process').execFileSync('git',['show','d186547:sw.js'],{cwd:root,encoding:'utf8'}):null;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const mime=name=>({'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.zip':'application/zip'})[path.extname(name)]||'application/octet-stream';
function snapshot(build,useLegacyWorker=false){
 const names=JSON.parse(fs.readFileSync(path.join(root,'version.json'),'utf8')).assets.map(asset=>asset.path);
 const files=new Map(names.map(name=>[name,fs.readFileSync(path.join(root,name))]));
 files.set('index.html',Buffer.from(files.get('index.html').toString().replace(/\d{8}-\d{6}/g,build)));
 files.set('sw.js',Buffer.from((useLegacyWorker?legacyWorker:files.get('sw.js').toString()).replace(/const BUILD_VERSION = "[^"]+"/,'const BUILD_VERSION = "'+build+'"')));
 const descriptor={build,assets:[...files].map(([name,bytes])=>({path:name,sha256:sha(bytes)}))};
 files.set('version.json',Buffer.from(JSON.stringify(descriptor)));
 return {build,files};
}
const releases=BUILDS.map((build,index)=>snapshot(build,legacyMode&&index===0));let live=0,corrupt=false,base,browser,context,page;
const requests=[];
const server=http.createServer((request,response)=>{
 const url=new URL(request.url,'http://localhost'),name=decodeURIComponent(url.pathname).replace(/^\/system-techo-v3\//,'/').replace(/^\//,'')||'index.html';
 const bytes=releases[live].files.get(name);
 requests.push({name,query:url.search,build:BUILDS[live]});
 if(!bytes)return response.writeHead(404,{'Cache-Control':'no-store'}).end();
 response.writeHead(200,{'Content-Type':mime(name),'Cache-Control':'no-store'});
 response.end(corrupt&&name==='js/app.js'?Buffer.concat([bytes,Buffer.from('\n// corrupt synthetic deployment\n')]):bytes);
});
async function until(check,message,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await check())return;}catch(error){if(!/Execution context was destroyed|Cannot find context/.test(error.message))throw error;}await delay(50);}assert.fail(message);}
async function activeBuild(){return page.evaluate(async()=>{
 const registration=await navigator.serviceWorker.getRegistration();if(!registration?.active)return null;
 return new Promise(resolve=>{const channel=new MessageChannel(),timer=setTimeout(()=>resolve(null),500);channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();resolve(event.data?.build);};registration.active.postMessage({type:'GET_BUILD_VERSION'},[channel.port2]);});
});}
async function preservation(){return page.evaluate(async()=>{
 const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('sth_v3',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 const outbox=await new Promise((resolve,reject)=>{const request=db.transaction('outbox','readonly').objectStore('outbox').getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 const version=db.version;db.close();
 const response=await (await caches.open('sth-att')).match('/_att/synthetic-preserve');
 return {preserved:localStorage.getItem('sw-test:preserve'),schema:localStorage.getItem('sth_v3_cache_schema'),health:localStorage.getItem('sth_v3_health_settings'),weight:document.querySelector('[data-id="weight"] input')?.value,attachment:response?await response.text():null,outbox,dbVersion:version};
});}
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port+(legacyMode?'/system-techo-v3/':'');
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'Asia/Tokyo',serviceWorkers:'allow'});
 const apiPosts=[],errors=[];
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin===new URL(base).origin)return route.continue();
  if(url.hostname!=='script.google.com')return route.abort();
  const payload=request.method()==='POST'?JSON.parse(request.postData()):Object.fromEntries(url.searchParams);
  if(request.method()==='POST'){apiPosts.push(payload);return route.fulfill({json:{ok:false,error:'No synthetic writes allowed in app update test'},headers:{'Access-Control-Allow-Origin':'*'}});}
  let data={tasks:[],events:[],entries:[],items:[],values:{},days:{},nodes:[],boards:[],board_items:[]};
  if(payload.type==='habit_items')data={items:[{id:'weight',label:'体重',type:'decimal',unit:'kg',icon:'•'}]};
  if(payload.type==='habit_day')data={values:{weight:61.5,unknown:{keep:0}}};
  return route.fulfill({json:{ok:true,data},headers:{'Access-Control-Allow-Origin':'*'}});
 });
 await context.addInitScript(()=>{
  if(localStorage.getItem('sw-test:seeded'))return;
  const now=new Date(),date=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
  localStorage.setItem('sw-test:seeded','1');localStorage.setItem('sth_v3_cache_schema','4');localStorage.setItem('sth_v3_active_tab','habit');
  localStorage.setItem('sth_v3_habit_items',JSON.stringify([{id:'weight',label:'体重',type:'decimal',unit:'kg',icon:'•'}]));
  localStorage.setItem('sth_v3_habitday_'+date,JSON.stringify({weight:61.5,unknown:{keep:0}}));
  localStorage.setItem('sw-test:preserve',' { "unknown":[0,false,"保持"] } ');
  localStorage.setItem('sth_v3_health_settings',JSON.stringify({enabled:false,shortcutName:'system-techo-health',pairKey:'a'.repeat(43),verifiedKeys:[]}));
 });
 page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base);await page.locator('[data-id="weight"] input').waitFor();
 if(legacyMode)await until(()=>page.evaluate(async()=>!!(await navigator.serviceWorker.getRegistration())?.active),'legacy worker active in original deployment scope',30000);
 else await until(async()=>await activeBuild()===BUILDS[0],'release A active after full verified install',30000);
 await until(()=>page.evaluate(()=>!!navigator.serviceWorker.controller),'release A controls page');
 await page.evaluate(async()=>{
  const cache=await caches.open('sth-att');await cache.put('/_att/synthetic-preserve',new Response('synthetic attachment bytes'));
  const {listAll}=await import('/js/outbox.js');await listAll();
 });
 const before=await preservation();assert.equal(before.dbVersion,1);assert.deepEqual(before.outbox,[]);assert.equal(before.weight,'61.5');
 console.log(legacyMode?'SETUP legacy d186547 worker controls release A without build-query support':'PASS release A installs verified static cache and preserves synthetic record stores');
 let reloads=0;page.on('framenavigated',frame=>{if(frame===page.mainFrame())reloads++;});
 live=1;
 await page.locator('#btn-settings').click();await page.locator('#settings-apply-update').click();
 await until(()=>page.evaluate(()=>document.querySelector('meta[name="app-build"]')?.content==='20270101-010102'),'settings upgrades to release B through actual Service Worker',40000);
 await page.locator('[data-id="weight"] input').waitFor();assert.equal(await activeBuild(),BUILDS[1]);assert.equal(reloads,1,'upgrade reloads same window exactly once');
 assert.deepEqual(await preservation(),before,'records, settings, attachment bytes and outbox schema survive upgrade');
 console.log('PASS settings update verifies assets and actual worker build, then reloads once into B');
 if(legacyMode){
  assert.equal(apiPosts.length,0,'legacy migration never POSTs records or reads Health');assert.deepEqual(errors,[]);
  const report={passed:1,mode:'legacy-to-atomic',legacyWorkerCommit:'d186547',fromBuild:BUILDS[0],toBuild:BUILDS[1],reloads:1,productionApiCalls:0,healthCalls:0,attachmentCachePreserved:true,recordStoresPreserved:true,apiPosts:apiPosts.length,staticRequests:requests.length};
  if(process.env.UPDATE_SW_SCREENSHOT){fs.mkdirSync(path.dirname(process.env.UPDATE_SW_SCREENSHOT),{recursive:true});await page.screenshot({path:process.env.UPDATE_SW_SCREENSHOT});}
  if(process.env.UPDATE_SW_REPORT){fs.mkdirSync(path.dirname(process.env.UPDATE_SW_REPORT),{recursive:true});fs.writeFileSync(process.env.UPDATE_SW_REPORT,JSON.stringify(report,null,2)+'\n');}
  console.log('Legacy Service Worker migration check: 1 passed');
  await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));return;
 }
 await page.evaluate(async()=>{await (await import('/js/outbox.js')).enqueue({type:'future_operation',payload:{id:'keep',unknown:[0,false]}});});
 const queued=await preservation();assert.equal(queued.outbox.length,1);
 await context.setOffline(true);await page.reload();await page.locator('[data-id="weight"] input').waitFor();
 assert.equal(await page.locator('meta[name="app-build"]').getAttribute('content'),BUILDS[1]);assert.deepEqual(await preservation(),queued,'offline boot retains queued unknown operation and attachment bytes');
 console.log('PASS verified B boots offline with records, unknown outbox row and attachment cache intact');
 await context.setOffline(false);live=2;corrupt=true;
 const failed=await page.evaluate(async()=>{
  const registration=await navigator.serviceWorker.getRegistration();
  let outcome='unobserved';registration.addEventListener('updatefound',()=>{const worker=registration.installing;if(!worker)return;worker.addEventListener('statechange',()=>{if(worker.state==='redundant')outcome='redundant';if(worker.state==='activated')outcome='activated';});});
  try{await registration.update();}catch(_){outcome='update-rejected';}
  const end=Date.now()+20000;while(Date.now()<end&&outcome==='unobserved')await new Promise(resolve=>setTimeout(resolve,50));
  return {outcome,cacheNames:await caches.keys()};
 });
 assert(['redundant','update-rejected'].includes(failed.outcome),'corrupt C install is rejected: '+failed.outcome);
 assert.equal(await activeBuild(),BUILDS[1]);assert(failed.cacheNames.includes('system-techo-v3-'+BUILDS[1]));assert(!failed.cacheNames.includes('system-techo-v3-'+BUILDS[2]));assert(failed.cacheNames.includes('sth-att'));
 await context.setOffline(true);await page.reload();await page.locator('[data-id="weight"] input').waitFor();
 assert.equal(await page.locator('meta[name="app-build"]').getAttribute('content'),BUILDS[1]);assert.deepEqual(await preservation(),queued);
 console.log('PASS corrupt C install cannot replace B; B remains bootable offline without record loss');
 assert.equal(apiPosts.length,0,'no application-record POST or Health operation occurs');assert.deepEqual(errors,[]);
 if(process.env.UPDATE_SW_SCREENSHOT){fs.mkdirSync(path.dirname(process.env.UPDATE_SW_SCREENSHOT),{recursive:true});await page.screenshot({path:process.env.UPDATE_SW_SCREENSHOT});}
 const report={passed:4,builds:BUILDS,reloadsBeforeOffline:1,failedInstall:failed.outcome,productionApiCalls:0,healthCalls:0,unknownOutboxPreserved:true,attachmentCachePreserved:true,apiPosts:apiPosts.length,staticRequests:requests.length};
 if(process.env.UPDATE_SW_REPORT){fs.mkdirSync(path.dirname(process.env.UPDATE_SW_REPORT),{recursive:true});fs.writeFileSync(process.env.UPDATE_SW_REPORT,JSON.stringify(report,null,2)+'\n');}
 console.log('Real Service Worker update checks: 4 passed');
 await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));
})().catch(async error=>{console.error(error);if(page)console.error('DIAG',await page.evaluate(()=>({build:document.querySelector('meta[name="app-build"]')?.content,status:document.querySelector('#settings-update-status')?.textContent,body:document.body.innerText.slice(-800)})).catch(()=>null));await context?.close();await browser?.close();server.close();process.exitCode=1;});
