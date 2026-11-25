// Isolated PWA settings tests: localhost + synthetic API, no production/Health access.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const root=process.env.APP_ROOT||path.resolve(__dirname,'..'),clone=x=>JSON.parse(JSON.stringify(x)),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const TODAY='2027-01-01',PAIR='a'.repeat(43),NEXT_BUILD='20991231-235959';
const items=[{id:'weight',label:'体重',type:'decimal',icon:'•',unit:'kg'},{id:'steps',label:'歩数',type:'integer',icon:'•',unit:'歩'},{id:'lastMeal',label:'前日の最終食事',type:'time',icon:'•',unit:''}];
const initialValues={weight:61.5,steps:1234,water:500,future:{zero:0,keep:false}};
const PRESERVED=' { "unknown":[0,false,"保持"], "attachment":"[[att:existing|写真.jpg|image/jpeg]]" } ';
const headers={'Access-Control-Allow-Origin':'*'};
const server=http.createServer((req,res)=>{
 const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
 if(!file.startsWith(root+path.sep))return res.writeHead(403).end();
 fs.readFile(file,(error,bytes)=>{if(error)return res.writeHead(404).end();res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.zip':'application/zip'})[path.extname(file)]||'text/html');res.end(bytes);});
});
let browser,base,passed=0,failed=0;
async function until(check,message,timeout=8000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await check())return;await delay(30);}assert.fail(message);}
const weight=page=>page.locator('[data-id="weight"] input');
function readBuild(){const index=fs.readFileSync(path.join(root,'index.html'),'utf8');return index.match(/name="app-build"\s+content="([^"]+)"/)?.[1]||fs.readFileSync(path.join(root,'sw.js'),'utf8').match(/const BUILD_VERSION = "([^"]+)"/)[1];}
function release(build){
 let index=fs.readFileSync(path.join(root,'index.html'),'utf8');
 index=index.includes('name="app-build"')?index.replace(/(<meta\s+name="app-build"\s+content=")[^"]+("\s*\/?>)/,'$1'+build+'$2'):index.replace('<head>','<head><meta name="app-build" content="'+build+'">');
 const content={'index.html':index,'sw.js':'// synthetic worker '+build,'js/app.js':'// synthetic staged bundle '+build};
 return {content,descriptor:{build,assets:Object.entries(content).map(([name,text])=>({path:name,sha256:crypto.createHash('sha256').update(text).digest('hex')}))}};
}
async function finishedMessage(page,pattern,message){await until(async()=>await page.locator('#settings-apply-update').isEnabled()&&pattern.test(await page.locator('#settings-update-status').textContent()),message);}
async function openSettings(page){await page.locator('#btn-settings').click();await page.locator('.app-settings-modal').waitFor();}
async function openInjectedSettings(page){await page.evaluate(async()=>{window.settingsTestReloads=0;const {showAppSettings}=await import('/js/settings/ui.js');showAppSettings({updaterOptions:{serviceWorker:null,reload:()=>{window.settingsTestReloads++;}}});});await page.locator('.app-settings-modal').waitFor();}
async function scenario(name,fn){
 if(process.env.SETTINGS_TEST&&!name.includes(process.env.SETTINGS_TEST))return;
 let context,page;
 try{
  context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});
  page=await context.newPage();page.setDefaultTimeout(4500);const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const posts=[],gets=[],assetGets=[],versionGets=[],values=clone(initialValues),opts={available:false,failVersion:false,corruptAsset:false,failPosts:false,postDelay:0};let navigations=0;
  page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations++;});
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.origin===base){
    const staged=release(opts.available?NEXT_BUILD:readBuild());
    if(url.pathname==='/version.json'){
     versionGets.push(url.href);if(opts.failVersion)return route.abort();
     return route.fulfill({json:staged.descriptor});
    }
    if(url.searchParams.has('_app_update')&&Object.hasOwn(staged.content,url.pathname.slice(1))){
     assetGets.push(url.pathname);let body=staged.content[url.pathname.slice(1)];if(opts.corruptAsset&&url.pathname==='/js/app.js')body+=' corrupt';
     return route.fulfill({body,contentType:url.pathname.endsWith('.js')?'text/javascript':'text/html'});
    }
    return route.continue();
   }
   if(url.protocol==='shortcuts:')return route.abort();
   if(url.hostname!=='script.google.com')return route.abort();
   const payload=request.method()==='POST'?JSON.parse(request.postData()):Object.fromEntries(url.searchParams);
   if(request.method()==='POST'){
    posts.push(clone(payload));await delay(opts.postDelay);if(opts.failPosts)return route.fulfill({json:{ok:false,error:'synthetic save unavailable'},headers});
    if(payload.type==='habit_day_upsert'){Object.assign(values,payload.set);for(const key of payload.del||[])delete values[key];}
    if(payload.type==='memo_attach')return route.fulfill({json:{ok:true,data:{id:'synthetic-attachment',name:payload.name,mime:payload.mime}},headers});
    if(payload.type==='health_bridge_read')return route.fulfill({json:{ok:true,data:{status:'waiting',date:payload.date}},headers});
    return route.fulfill({json:{ok:true,data:{}},headers});
   }
   gets.push(payload.type);let data={tasks:[],entries:[],events:[],items:[],values:{},days:{},nodes:[],boards:[],board_items:[]};
   if(payload.type==='habit_items')data={items:clone(items)};
   if(payload.type==='habit_day')data={values:clone(values)};
   return route.fulfill({json:{ok:true,data},headers});
  });
  await page.clock.setFixedTime(new Date('2027-01-01T12:00:00'));
  await page.addInitScript(({items,initialValues,preserved,pair,today})=>{
   window.settingsTestShortcutLaunches=[];
   window.navigation?.addEventListener('navigate',event=>{if(event.destination.url.startsWith('shortcuts:')){window.settingsTestShortcutLaunches.push(event.destination.url);event.preventDefault();}});
   if(localStorage.getItem('settings-test:seeded'))return;
   localStorage.setItem('settings-test:seeded','1');localStorage.setItem('sth_v3_cache_schema','4');localStorage.setItem('sth_v3_active_tab','habit');
   localStorage.setItem('sth_v3_habit_items',JSON.stringify(items));localStorage.setItem('sth_v3_habitday_'+today,JSON.stringify(initialValues));
   localStorage.setItem('preserve:settings-test',preserved);
   localStorage.setItem('sth_v3_health_settings',JSON.stringify({enabled:false,shortcutName:'system-techo-health',pairKey:pair,verifiedKeys:[]}));
  },{items,initialValues,preserved:PRESERVED,pair:PAIR,today:TODAY});
  await page.goto(base);await weight(page).waitFor();await until(()=>Promise.resolve(gets.includes('habit_day')),'initial synthetic habit read');await delay(100);
  await fn({page,context,posts,gets,assetGets,versionGets,values,opts,navigations:()=>navigations});
  assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>localStorage.getItem('preserve:settings-test')),PRESERVED,'unknown cache stays byte-for-byte intact');
  assert.equal(await page.evaluate(()=>localStorage.getItem('sth_v3_cache_schema')),'4');
  assert.equal(await page.evaluate(()=>window.settingsTestShortcutLaunches.length),0,'settings never launches an actual Shortcut');
  passed++;console.log('PASS '+name);
 }catch(error){failed++;console.log('FAIL '+name+': '+error.message);if(process.env.SETTINGS_DIAGNOSTICS&&page)console.log('DIAG',await page.evaluate(()=>({status:document.querySelector('#settings-update-status')?.textContent,modals:[...document.querySelectorAll('.modal-backdrop')].map(el=>el.className),text:document.body.innerText.slice(-1600)})));}finally{await context?.close();}
}
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 await scenario('header settings fit mobile and expose blank operator/contact plus working information links',async({page,context,posts,values})=>{
  assert.equal(await page.locator('#btn-settings').count(),1,'global settings button exists');
  const header=await page.locator('#app-header').boundingBox();assert(header&&header.x>=0&&header.x+header.width<=390);
  for(const button of await page.locator('#app-header button').all()){const box=await button.boundingBox();assert(box&&box.x>=0&&box.x+box.width<=390,'header buttons stay on-screen');}
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'no horizontal document overflow');
  if(process.env.HEADER_SCREENSHOT)await page.screenshot({path:process.env.HEADER_SCREENSHOT});
  await openSettings(page);
  assert.equal((await page.locator('#settings-operator').textContent()).trim(),'');assert.equal((await page.locator('#settings-contact').textContent()).trim(),'');
  for(const file of ['privacy.html','support.html']){
   const link=page.locator('.app-settings-modal a[href="'+file+'"]');assert.equal(await link.count(),1);
   const response=await context.request.get(base+'/'+file);assert.equal(response.status(),200);assert((await response.text()).includes('システム手帳'));
  }
  const close=await page.locator('#settings-close').boundingBox();assert(close&&close.y>=0&&close.y+close.height<=844,'dialog close stays in viewport');
  if(process.env.SETTINGS_SCREENSHOT)await page.screenshot({path:process.env.SETTINGS_SCREENSHOT});
  if(process.env.SETTINGS_LIGHT_SCREENSHOT){await page.evaluate(()=>{document.documentElement.dataset.theme='cream';document.documentElement.dataset.kind='light';});await page.screenshot({path:process.env.SETTINGS_LIGHT_SCREENSHOT});}
  await page.locator('#settings-close').click();assert.equal(await page.locator('.app-settings-modal').count(),0);assert.deepEqual(values,initialValues);assert.equal(posts.length,0);
 });
 await scenario('current build check keeps the current page and all saved records',async({page,versionGets,assetGets,posts,values,navigations})=>{
  const before=navigations();await openSettings(page);await page.locator('#settings-apply-update').click();
  await finishedMessage(page,/このアプリは最新版です/,'already-latest message');
  assert.equal(navigations(),before);assert.equal(versionGets.length,1);assert.equal(assetGets.length,0);assert.equal(posts.length,0);assert.deepEqual(values,initialValues);
  assert.equal(await page.locator('#settings-apply-update').isEnabled(),true);
 });
 await scenario('offline version check does not reload or clear local records',async({page,opts,versionGets,values,navigations})=>{
  opts.failVersion=true;const before=navigations();await openSettings(page);await page.locator('#settings-apply-update').click();
  await finishedMessage(page,/取得|通信|接続/,'offline update error');
  assert.equal(navigations(),before);assert.equal(versionGets.length,1);assert.deepEqual(values,initialValues);assert.equal(await page.locator('#settings-close').isEnabled(),true);
 });
 await scenario('closing settings retains the latest hand edit and its failed outbox row',async({page,opts})=>{
  opts.failPosts=true;await weight(page).fill('63.7');await weight(page).blur();await delay(150);await openSettings(page);
  const before=await page.evaluate(async()=>(await import('/js/outbox.js')).listAll());assert(before.length>0,'manual edit persisted to outbox');
  await page.locator('#settings-close').click();assert.equal(await weight(page).inputValue(),'63.7');
  assert.deepEqual(await page.evaluate(async()=>(await import('/js/outbox.js')).listAll()),before);
 });
 await scenario('pending Health import blocks application upgrade and leaves the request intact',async({page,opts,assetGets,navigations})=>{
  opts.available=true;const request=await page.evaluate(({today})=>{const request={request_id:'b'.repeat(43),date:today,issued_at:Date.now(),baseline:{weight:61.5},editedKeys:[]};localStorage.setItem('sth_v3_health_pending',JSON.stringify(request));return request;},{today:TODAY});
  const before=navigations();await openSettings(page);await page.locator('#settings-apply-update').click();
  await finishedMessage(page,/ヘルスケア/,'pending Health refusal');
  assert.equal(navigations(),before);assert.equal(assetGets.length,0);assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('sth_v3_health_pending'))),request);
 });
 await scenario('unknown existing outbox operations block reload without losing IDs or payloads',async({page,opts,assetGets,navigations})=>{
  opts.available=true;const beforeRows=await page.evaluate(async()=>{const outbox=await import('/js/outbox.js');await outbox.enqueue({type:'future_unknown_operation',payload:{id:'keep-future',zero:0,flag:false}});return outbox.listAll();});
  const before=navigations();await openSettings(page);await page.locator('#settings-apply-update').click();
  await finishedMessage(page,/未送信|送信待ち/,'outbox refusal');
  assert.equal(navigations(),before);assert.equal(assetGets.length,0);assert.deepEqual(await page.evaluate(async()=>(await import('/js/outbox.js')).listAll()),beforeRows);
 });
 await scenario('memo detail editing blocks reload and keeps unsaved text in its editor',async({page,opts,assetGets,navigations})=>{
  opts.available=true;opts.failPosts=true;await page.locator('[data-tab="memo"]').click();await page.locator('#btn-new-memo').click();await page.locator('#d-text').fill('消してはいけない入力途中のメモ');
  const before=navigations();await openSettings(page);await page.locator('#settings-apply-update').click();
  await finishedMessage(page,/メモ|編集/,'memo detail refusal');
  assert.equal(navigations(),before);assert.equal(assetGets.length,0);await page.locator('#settings-close').click();assert.equal(await page.locator('#d-text').inputValue(),'消してはいけない入力途中のメモ');
 });
 await scenario('direct API save in progress blocks upgrade until its synthetic response finishes',async({page,opts,posts,assetGets,navigations})=>{
  opts.available=true;opts.postDelay=1500;
  await page.evaluate(async()=>{const gas=await import('/js/gas-client.js');window.settingsTestWrite=gas.pushTaskUpsert({id:'settings-inflight-probe',title:'合成の保存待ち'}).catch(error=>error.message);});
  await until(()=>Promise.resolve(posts.some(post=>post.type==='task_upsert')),'synthetic direct write is in flight');
  const before=navigations();await openSettings(page);await page.locator('#settings-apply-update').click();
  await finishedMessage(page,/保存|通信/,'in-flight API save refusal');assert.equal(navigations(),before);assert.equal(assetGets.length,0);
  await page.evaluate(()=>window.settingsTestWrite);
 });
 await scenario('attachment upload in progress blocks upgrade without discarding the synthetic file',async({page,opts,posts,assetGets,navigations})=>{
  opts.available=true;opts.postDelay=1500;
  await page.evaluate(async()=>{const {uploadFile}=await import('/js/memo/attachments.js');window.settingsTestUpload=uploadFile(new File(['synthetic only'],'synthetic.txt',{type:'text/plain'})).catch(error=>({error:error.message}));});
  await until(()=>Promise.resolve(posts.some(post=>post.type==='memo_attach')),'synthetic upload is in flight');
  const before=navigations();await openSettings(page);await page.locator('#settings-apply-update').click();
  await finishedMessage(page,/写真|添付/,'upload refusal');assert.equal(navigations(),before);assert.equal(assetGets.length,0);
  assert.equal((await page.evaluate(()=>window.settingsTestUpload)).id,'synthetic-attachment');
 });
 await scenario('verified new build requests one same-window reload through the test seam',async({page,opts,assetGets,values,navigations})=>{
  opts.available=true;const before=navigations();await openInjectedSettings(page);await page.locator('#settings-apply-update').click();
  await until(()=>page.evaluate(()=>window.settingsTestReloads===1),'one verified reload requested');
  assert.equal(navigations(),before,'the synthetic reload never navigates a real page');assert.deepEqual(assetGets.sort(),['/index.html','/js/app.js','/sw.js']);assert.deepEqual(values,initialValues);
 });
 await scenario('mismatched staged asset stops upgrade before any reload',async({page,opts,navigations})=>{
  opts.available=true;opts.corruptAsset=true;const before=navigations();await openInjectedSettings(page);await page.locator('#settings-apply-update').click();
  await finishedMessage(page,/まだ揃|一致しない|停止/,'asset mismatch refusal');
  assert.equal(await page.evaluate(()=>window.settingsTestReloads),0);assert.equal(navigations(),before);
 });
 await scenario('missing current-build metadata leaves update controls usable and records unchanged',async({page,posts,values,navigations})=>{
  await page.evaluate(()=>document.querySelector('meta[name="app-build"]')?.remove());
  const before=navigations();await openSettings(page);await page.locator('#settings-apply-update').click();
  await finishedMessage(page,/現在|版|確認でき/,'invalid current build is shown without leaving controls locked');
  assert.equal(await page.locator('#settings-close').isEnabled(),true);assert.equal(navigations(),before);assert.equal(posts.length,0);assert.deepEqual(values,initialValues);
 });
 await scenario('settings opens the existing Health configuration with the stored pairing preserved',async({page})=>{
  const before=await page.evaluate(()=>localStorage.getItem('sth_v3_health_settings'));await openSettings(page);await page.locator('#settings-open-health').click();
  assert.equal(await page.locator('.app-settings-modal').count(),0);await page.locator('.health-modal').waitFor();assert.equal(await page.locator('#health-pair-key').inputValue(),PAIR);
  assert.equal(await page.evaluate(()=>localStorage.getItem('sth_v3_health_settings')),before);
 });
 await scenario('opening Health settings from a memo keeps the memo editor and its draft intact',async({page,opts})=>{
  opts.failPosts=true;await page.locator('[data-tab="memo"]').click();await page.locator('#btn-new-memo').click();await page.locator('#d-text').fill('ヘルスケア設定を開いても残すメモ');
  await openSettings(page);await page.locator('#settings-open-health').click();await page.locator('.health-modal').waitFor();
  assert.equal(await page.locator('.memo-detail').count(),1,'Health settings do not force a tab switch');
  await page.locator('#health-settings-close').click();assert.equal(await page.locator('#d-text').inputValue(),'ヘルスケア設定を開いても残すメモ');
 });
 await browser.close();await new Promise(resolve=>server.close(resolve));console.log('App settings browser checks: '+passed+' passed, '+failed+' failed');process.exitCode=failed?1:0;
})().catch(async error=>{console.error(error);await browser?.close();server.close();process.exitCode=1;});
