// Synthetic API and isolated browser only. Never contacts production GAS.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const root=process.env.APP_ROOT||path.resolve(__dirname,'..'),clone=x=>JSON.parse(JSON.stringify(x)),delay=ms=>new Promise(r=>setTimeout(r,ms));
const TODAY='2027-01-01',PREV='2026-12-31';
const items=[{id:'lastMeal',label:'前日の最終食事',type:'time',icon:'•',unit:''},{id:'weight',label:'体重',type:'decimal',icon:'•',unit:'kg'}];
const headers={'Access-Control-Allow-Origin':'*'};
const server=http.createServer((req,res)=>{
 const rel=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(root,'.'+(rel==='/'?'/index.html':rel));
 if(!file.startsWith(root+path.sep))return res.writeHead(403).end();
 fs.readFile(file,(e,b)=>{if(e)return res.writeHead(404).end();res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.json':'application/json'})[path.extname(file)]||'text/html');res.end(b);});
});
let browser,base,passed=0,failed=0;
async function until(check,message,timeout=3000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(25);}assert.fail(message);}
const field=p=>p.locator('[data-id="lastMeal"] input');
const refresh=p=>p.locator('#btn-refresh').click();
const autoPosts=posts=>posts.filter(p=>p.type==='habit_day_upsert'&&p.set?.lastMeal==='22:45');
async function scenario(name,fn){
 if(process.env.LAST_MEAL_TEST&&!name.includes(process.env.LAST_MEAL_TEST))return;
 let ctx;
 try{
  ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});
  const page=await ctx.newPage();page.setDefaultTimeout(4000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const values={[TODAY]:{lastMeal:'18:15',weight:61.5,future_value:{keep:0}},[PREV]:{lastMeal:'17:15',weight:62,previous_only:true}};
  const days={[PREV]:{朝:{time:'08:00',text:'朝食'},昼:{time:'12:30',text:'昼食'},夕:{time:'19:00',text:'夕食'},間食:{time:'22:45',text:'間食'},夜食:{time:'21:30',text:'夜食'},unknown_slot:{time:'23:59',keep:true}},[TODAY]:{夕:{time:'23:30',text:'当日の食事'}}};
  const opts={mealDelay:0,postDelay:0,failMeal:false,failPosts:false,items:clone(items)},gets=[],posts=[];
  await ctx.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.origin===base)return route.continue();
   if(url.hostname!=='script.google.com')return route.abort();
   const p=req.method()==='POST'?JSON.parse(req.postData()):Object.fromEntries(url.searchParams);
   if(req.method()==='POST'){
    posts.push(clone(p));await delay(opts.postDelay);if(opts.failPosts)return route.fulfill({json:{ok:false,error:'synthetic save failure'},headers});
    if(p.type==='habit_day_upsert'){values[p.date]||={};Object.assign(values[p.date],p.set);for(const k of p.del)delete values[p.date][k];}
    if(p.type==='meal_day_upsert')days[p.date]={...days[p.date],...p.set};
    return route.fulfill({json:{ok:true,data:{}},headers});
   }
   gets.push(clone(p));let data={tasks:[],entries:[],events:[],items:[],values:{},days:{}};
   if(p.type==='habit_items')data={items:clone(opts.items)};
   else if(p.type==='habit_day')data={values:clone(values[p.date]||{})};
   else if(p.type==='meal_month'){
    data={days:clone(Object.fromEntries(Object.entries(days).filter(([date])=>date.startsWith(p.month+'-'))))};
    await delay(opts.mealDelay);if(opts.failMeal)return route.fulfill({json:{ok:false,error:'synthetic meal read failure'},headers});
   }
   return route.fulfill({json:{ok:true,data},headers});
  });
  await page.clock.setFixedTime(new Date('2027-01-01T12:00:00'));
  await page.addInitScript(({values,items})=>{
   localStorage.setItem('sth_v3_cache_schema','4');localStorage.setItem('sth_v3_active_tab','habit');localStorage.setItem('sth_v3_habit_items',JSON.stringify(items));
   for(const [date,value]of Object.entries(values))localStorage.setItem('sth_v3_habitday_'+date,JSON.stringify(value));
   localStorage.setItem('preserve:unknown',' unchanged ');
  },{values:clone(values),items});
  await page.goto(base);await field(page).waitFor();
  await until(()=>Promise.resolve(gets.some(p=>p.type==='habit_day')),'initial habit pull');await delay(120);
  await fn({page,values,days,opts,gets,posts});
  assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>localStorage.getItem('preserve:unknown')),' unchanged ');
  passed++;console.log('PASS '+name);
 }catch(e){failed++;console.log('FAIL '+name+': '+e.message);}finally{await ctx?.close();}
}
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 await scenario('manual refresh imports max across year boundary with a one-field patch',async({page,values,days,gets,posts})=>{
  const beforeDays=clone(days),beforePrev=clone(values[PREV]);
  assert.equal(gets.filter(p=>p.type==='meal_month').length,0,'ordinary habit entry does not read meals');
  await refresh(page);await until(()=>Promise.resolve(autoPosts(posts).length===1),'refresh must persist previous meal max');
  assert.equal(await field(page).inputValue(),'22:45');
  assert.deepEqual(gets.filter(p=>p.type==='meal_month').map(p=>p.month),['2026-12']);
  assert.deepEqual(autoPosts(posts)[0],{type:'habit_day_upsert',date:TODAY,set:{lastMeal:'22:45'},del:[]});
  assert.deepEqual(values[TODAY],{lastMeal:'22:45',weight:61.5,future_value:{keep:0}});
  assert.deepEqual(values[PREV],beforePrev);assert.deepEqual(days,beforeDays);
  assert.equal(await page.evaluate(date=>JSON.parse(localStorage.getItem('sth_v3_habitday_'+date)).lastMeal,TODAY),'22:45');
  await page.locator('#spinner-root').waitFor({state:'hidden'});
  await until(async()=>(await page.locator('.toast-success').allTextContents()).some(text=>text==='更新を確認しました'),'refresh confirms completed save without pending count');
  const shot=process.env.LAST_MEAL_SCREENSHOT;if(shot){fs.mkdirSync(path.dirname(shot),{recursive:true});await page.screenshot({path:shot,fullPage:true});}
  await refresh(page);await delay(200);assert.equal(autoPosts(posts).length,1,'unchanged value does not save twice');
 });
 await scenario('manual refresh imports an empty lastMeal when Safari retains an unchanged input focus',async({page,values,days,posts})=>{
  delete values[TODAY].lastMeal;
  values['2027-01-02']={lastMeal:'19:10',weight:60,future_next:{keep:false}};
  await page.evaluate(({date,values})=>localStorage.setItem('sth_v3_habitday_'+date,JSON.stringify(values)),{date:TODAY,values:clone(values[TODAY])});
  await page.locator('[data-tab="task"]').click();await page.locator('[data-tab="habit"]').click();
  await until(async()=>(await field(page).inputValue())==='','target starts empty');
  const beforeValues=clone(values),beforeDays=clone(days);
  // Safari does not focus a clicked button. Reproduce that focus behavior in Chrome.
  await page.evaluate(()=>{
   const button=document.querySelector('#btn-refresh');
   button.addEventListener('mousedown',event=>event.preventDefault());
   button.addEventListener('click',()=>{window.testSafariRetainedFocus=document.activeElement?.closest('[data-id="weight"]')!=null;},{capture:true});
  });
  const weight=page.locator('[data-id="weight"] input');await weight.focus();
  assert.equal(await weight.inputValue(),'61.5','focused field is unchanged');
  await refresh(page);
  assert.equal(await page.evaluate(()=>window.testSafariRetainedFocus),true,'input remains focused at refresh click dispatch as on Safari');
  await until(()=>Promise.resolve(autoPosts(posts).length===1),'retained but unchanged focus must not skip manual import');
  assert.equal(await field(page).inputValue(),'22:45');
  assert.deepEqual(autoPosts(posts)[0],{type:'habit_day_upsert',date:TODAY,set:{lastMeal:'22:45'},del:[]});
  assert.deepEqual(values,{...beforeValues,[TODAY]:{...beforeValues[TODAY],lastMeal:'22:45'}},'only the selected day and field change');
  assert.deepEqual(days,beforeDays,'all meal dates remain unchanged');
 });
 await scenario('ordinary entry and date navigation do not import meals',async({page,gets,posts})=>{
  await page.locator('#h-prev').click();await delay(100);await page.locator('#h-next').click();await delay(100);
  await page.locator('[data-tab="task"]').click();await page.locator('[data-tab="habit"]').click();await delay(150);
  assert.equal(gets.filter(p=>p.type==='meal_month').length,0);assert.equal(autoPosts(posts).length,0);assert.equal(await field(page).inputValue(),'18:15');
 });
 await scenario('midnight is valid and normalized while out-of-range times are ignored',async({page,days,values,posts})=>{
  days[PREV]={朝:{time:'0:00'},夕:{time:'24:00'},夜食:{time:'23:60'}};
  await refresh(page);await until(()=>Promise.resolve(posts.some(p=>p.set?.lastMeal==='00:00')),'midnight must save');
  assert.equal(await field(page).inputValue(),'00:00');assert.equal(values[TODAY].lastMeal,'00:00');
 });
 for(const fixture of ['missing','invalid'])await scenario('no valid meal time preserves current lastMeal: '+fixture,async({page,days,posts})=>{
  if(fixture==='missing')delete days[PREV];else days[PREV]={朝:{time:'24:00'},昼:{time:'12:99'},夕:{time:'-1:00'},間食:{time:'23:59trailing'},夜食:{time:''}};
  await refresh(page);await delay(180);assert.equal(await field(page).inputValue(),'18:15');assert.equal(posts.filter(p=>p.type==='habit_day_upsert').length,0);
 });
 await scenario('meal read failure preserves lastMeal and still refreshes other habits',async({page,opts,posts,values})=>{
  values[TODAY].weight=62.5;opts.failMeal=true;await refresh(page);await delay(180);
  assert.equal(await field(page).inputValue(),'18:15');
  assert.deepEqual(await page.evaluate(date=>JSON.parse(localStorage.getItem('sth_v3_habitday_'+date)),TODAY),{lastMeal:'18:15',weight:62.5,future_value:{keep:0}});
  assert.equal(posts.filter(p=>p.type==='habit_day_upsert').length,0);
 });
 await scenario('manual edit during delayed read wins over imported time',async({page,opts,gets,posts,values})=>{
  opts.mealDelay=450;await refresh(page);await until(()=>Promise.resolve(gets.some(p=>p.type==='meal_month')),'meal read starts');
  await field(page).fill('20:10');await field(page).blur();await delay(650);
  assert.equal(await field(page).inputValue(),'20:10');assert.equal(values[TODAY].lastMeal,'20:10');assert.equal(autoPosts(posts).length,0);
 });
 await scenario('late meal read cannot write after selected day changes',async({page,opts,gets,posts,values})=>{
  opts.mealDelay=450;await refresh(page);await until(()=>Promise.resolve(gets.some(p=>p.type==='meal_month')),'meal read starts');
  // Keyboard activation changes date while the existing pointer-blocking spinner is visible.
  await page.locator('#h-prev').press('Enter');await delay(650);
  assert.equal(await field(page).inputValue(),'17:15');assert.equal(values[TODAY].lastMeal,'18:15');assert.equal(autoPosts(posts).length,0);
 });
 await scenario('late meal read cannot write after tab changes',async({page,opts,gets,posts,values})=>{
  opts.mealDelay=450;await refresh(page);await until(()=>Promise.resolve(gets.some(p=>p.type==='meal_month')),'meal read starts');
  // Keyboard activation must happen before the delayed response, not after the spinner closes.
  await page.locator('[data-tab="task"]').press('Enter');await delay(650);
  assert.equal(await page.locator('.task-tab').count(),1);assert.equal(values[TODAY].lastMeal,'18:15');assert.equal(autoPosts(posts).length,0);
 });
 for(const type of ['meal','habit'])await scenario('pending failed '+type+' write protects against stale import',async({page,opts,posts})=>{
  opts.failPosts=true;
  await page.evaluate(async({type,today,prev})=>{
   const outbox=await import('/js/outbox.js');
   await outbox.enqueue(type==='meal'?{type:'meal_day_upsert',payload:{date:prev,set:{夜食:{time:'23:15',text:'未送信'}}}}:{type:'habit_day_upsert',payload:{date:today,set:{lastMeal:'20:20'},del:[]}});
  },{type,today:TODAY,prev:PREV});
  await refresh(page);await delay(180);assert.equal(autoPosts(posts).length,0);assert.equal(await field(page).inputValue(),'18:15');
  assert.equal(await page.evaluate(async()=>(await import('/js/outbox.js')).count()),1,'pending row retained');
 });
 await scenario('removed lastMeal item does not get a hidden automatic record',async({page,opts,values,posts})=>{
  opts.items=opts.items.filter(item=>item.id!=='lastMeal');
  await refresh(page);await delay(200);
  assert.equal(await field(page).count(),0);
  assert.equal(autoPosts(posts).length,0);assert.equal(values[TODAY].lastMeal,'18:15');
 });
 await scenario('source edit after meal read started protects against older remote result',async({page,opts,gets,posts})=>{
  opts.mealDelay=450;await refresh(page);await until(()=>Promise.resolve(gets.some(p=>p.type==='meal_month')),'meal read starts');
  await page.evaluate(async date=>{
   await (await import('/js/sync.js')).queue({type:'meal_day_upsert',payload:{date,set:{夜食:{time:'23:15',text:'取得後の編集'}}}});
  },PREV);
  await delay(650);assert.equal(autoPosts(posts).length,0);assert.equal(await field(page).inputValue(),'18:15');
 });
 await scenario('manual edit while refresh waits for old outbox flush wins over derived time',async({page,opts,posts,values})=>{
  opts.postDelay=450;
  await page.evaluate(async date=>{
   await (await import('/js/outbox.js')).enqueue({type:'habit_day_upsert',payload:{date,set:{weight:63},del:[]}});
  },PREV);
  await refresh(page);
  await until(()=>Promise.resolve(posts.some(p=>p.type==='habit_day_upsert'&&p.date===PREV)),'old outbox flush starts');
  await field(page).fill('20:10');await field(page).blur();
  await page.locator('#spinner-root').waitFor({state:'hidden'});await delay(500);
  assert.equal(await field(page).inputValue(),'20:10');assert.equal(values[TODAY].lastMeal,'20:10');
  assert.equal(autoPosts(posts).length,0,'refresh must not overwrite an edit made while flush was pending');
 });
 await browser.close();await new Promise(r=>server.close(r));console.log('RESULT '+passed+' passed, '+failed+' failed');process.exitCode=failed?1:0;
})().catch(async e=>{console.error(e);await browser?.close();server.close();process.exitCode=1;});
