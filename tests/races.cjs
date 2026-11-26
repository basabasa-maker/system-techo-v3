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
async function until(check,message){const end=Date.now()+7000;while(Date.now()<end){if(await check())return;await delay(30);}assert.fail(message);}
// The memo keeps the same plain-text contract with either legacy textarea or
// the rebuilt contenteditable editor. These fixtures are short, nonvirtual rows.
const memoInput=page=>page.locator('#d-text .cm-content, textarea#d-text');
const memoValue=page=>memoInput(page).evaluate(el=>el.tagName==='TEXTAREA'?el.value:Array.from(el.querySelectorAll('.cm-line')).map(line=>line.textContent).join('\n'));
const items=[{id:'count',label:'試験累計',type:'cumulative',icon:'⭐',unit:'件'},{id:'n',label:'試験数値',type:'integer',icon:'⭐',unit:'件'},{id:'t',label:'試験時刻',type:'time',icon:'⭐',unit:''}];
let browser, failures=0;
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 async function scenario(name,fn){if(process.env.RACE_TEST&&!name.includes(process.env.RACE_TEST))return;let ctx;try{
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
 }catch(e){failures++;console.log('FAIL',name,e.stack||e.message);}finally{await ctx?.close();}}
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

 // Preserve existing storage bytes and IndexedDB operation identities across app startup.
 // The harness reseeds active_tab/habit_items on every document, so those two keys
 // deliberately use the harness values rather than a competing second init script.
 await scenario('existing schema-4 caches and outbox survive offline reload unchanged',async({page,opts})=>{
 await delay(850);opts.offline=true;
 const before=await page.evaluate(async({items})=>{
   const {todayYmd}=await import('/js/date-util.js');const day=todayYmd();
   const raw={
     sth_v3_cache_schema:'4',
     sth_v3_active_tab:'habit',
     sth_v3_habit_items:JSON.stringify(items),
     sth_v3_tasks_cache:' [ { "id":"preserve-task", "title":"既存タスク", "due_date":"2026-11-30", "created_at":"2026-11-01 10:00", "updated_at":"2026-11-02 11:00", "deleted":0, "pinned":1, "sort_order":20, "future_field":"keep" } ] ',
     sth_v3_memo_all:' [ { "id":"preserve-memo", "entry_type":"note", "title":"既存メモ", "body":"本文", "claude_taken":"2026-11-20 09:15", "pinned":1, "sort_order":30, "archived":0 } ] ',
     sth_v3_memo_notes:' [ { "id":"preserve-note", "body":"別のキャッシュ" } ] ',
     sth_v3_task_sort:'manual',
     'preservation:future-key':' { "未知の設定": [0,false,"保持"] } ',
   };
   raw['sth_v3_habitday_'+day]=' { "count":51, "n":0, "future_habit":{"keep":true} } ';
   raw['sth_v3_mealday_'+day]=' { "朝":{"time":"08:00","text":"既存の朝食"}, "unknown_slot":{"text":"keep"} } ';
   raw['sth_v3_cal_'+day]=' [ { "id":"preserve-calendar", "summary":"既存予定" } ] ';
   raw['sth_v3_journal_'+day]=' [ { "id":"preserve-journal", "body":"既存日記" } ] ';
   raw['sth_v3_memoday_'+day]=' [ { "id":"preserve-memoday", "entry_type":"journal", "body":"時間軸キャッシュ" } ] ';
   for(const [key,value]of Object.entries(raw))localStorage.setItem(key,value);
   const outbox=await import('/js/outbox.js');
   const ops=[
     {type:'task_upsert',payload:{id:'preserve-task',title:'未送信タスク',future_field:0}},
     {type:'memo_upsert',payload:{id:'preserve-memo',entry_type:'note',body:'未送信メモ',claude_taken:'2026-11-20 09:15'}},
     {type:'habit_day_upsert',payload:{date:day,set:{n:0},del:['old_habit']}},
     {type:'meal_day_upsert',payload:{date:day,set:{'朝':{time:'08:15',text:'未送信の朝食'}}}},
     {type:'future_unknown_operation',payload:{id:'preserve-unknown',nested:{zero:0,flag:false,text:'未知の送信待ち'}}},
   ];
   for(const op of ops)await outbox.enqueue(op);
   return {raw,rows:await outbox.listAll()};
 },{items});
 assert.equal(before.rows.length,5);
 await page.reload();await page.locator('[data-id="count"] input').waitFor();
 // Let startup attempt to flush every known operation; all API calls fail offline.
 await delay(300);
 const after=await page.evaluate(async keys=>({
   raw:Object.fromEntries(keys.map(key=>[key,localStorage.getItem(key)])),
   rows:await(await import('/js/outbox.js')).listAll(),
 }),Object.keys(before.raw));
 assert.deepStrictEqual(after.raw,before.raw,'startup must preserve every existing raw cache value');
 assert.deepStrictEqual(after.rows,before.rows,'offline flush must retain ids, timestamps, payloads, and unknown operations');
 assert.equal(await page.locator('[data-id="count"] input').inputValue(),'51');
 });

 // Legacy payloads are partial updates too: they cannot erase unrelated fields.
 // Later edits win, including 0, deletion, resurrection, and clearing a meal slot.
 await scenario('legacy values/slots compose with modern patches in original queue order',async({page,opts,values,days,posts})=>{
 await delay(850);opts.getDelay=0;opts.postDelay=0;
 const day='2000-02-03';
 Object.assign(values,{untouched:999,removeMe:1,revived:9});
 days[day]={'朝':{time:'07:00',text:'サーバー朝食'},'間食':{time:'15:00',text:'変更しない間食'}};
 const start=posts.length;
 const rows=await page.evaluate(async day=>{
   const outbox=await import('/js/outbox.js');
   const ops=[
     {type:'habit_day_upsert',payload:{date:day,values:{count:11,zero:8,legacyOnly:4,resurrect:5}}},
     {type:'habit_day_upsert',payload:{date:day,set:{count:0,zero:0,revived:-2},del:['removeMe','resurrect','legacyOnly']}},
     {type:'habit_day_upsert',payload:{date:day,set:{legacyOnly:0,resurrect:0},del:['revived']}},
     {type:'meal_day_upsert',payload:{date:day,slots:{'朝':{time:'08:00',text:'旧形式の朝食'},'昼':{time:'12:00',text:'旧形式の昼食'}}}},
     {type:'meal_day_upsert',payload:{date:day,set:{'朝':{time:'',text:''},'夕':{time:'18:00',text:'新形式の夕食'}}}},
     {type:'meal_day_upsert',payload:{date:day,slots:{'昼':{time:'12:30',text:'あとから更新した旧形式の昼食'}}}},
   ];
   for(const op of ops)await outbox.enqueue(op);
   const rows=await outbox.listAll();
   await(await import('/js/sync.js')).flushAll();
   return rows;
 },day);
 assert.equal(rows.length,6);assert(rows.every((row,index)=>index===0||rows[index-1].id<row.id));
 const sent=posts.slice(start);assert.equal(sent.length,2,'one merged request per target');
 assert.deepStrictEqual(sent.map(x=>x.type),['habit_day_upsert','meal_day_upsert']);
 assert.equal(sent[0].date,day);assert(!('values'in sent[0]));
 assert.deepStrictEqual(sent[0].set,{count:0,zero:0,legacyOnly:0,resurrect:0});
 assert.deepStrictEqual([...sent[0].del].sort(),['removeMe','revived']);
 assert.equal(values.count,0);assert.equal(values.zero,0);assert.equal(values.legacyOnly,0);assert.equal(values.resurrect,0);
 assert.equal(values.untouched,999);assert(!('removeMe'in values));assert(!('revived'in values));
 assert.equal(sent[1].date,day);assert(!('slots'in sent[1]));
 assert.deepStrictEqual(sent[1].set,{'朝':{time:'',text:''},'昼':{time:'12:30',text:'あとから更新した旧形式の昼食'},'夕':{time:'18:00',text:'新形式の夕食'}});
 assert.deepStrictEqual(days[day],{'朝':{time:'',text:''},'間食':{time:'15:00',text:'変更しない間食'},'昼':{time:'12:30',text:'あとから更新した旧形式の昼食'},'夕':{time:'18:00',text:'新形式の夕食'}});
 assert.equal(await page.evaluate(async()=> (await import('/js/outbox.js')).count()),0);
 });

 // Use the public memo editor and its real 700ms autosave. No attachment fetch:
 // PDF is rendered as a button, so its token can be tested without a fake file API.
 await scenario('memo edit retains attachment tokens, unknown text, and metadata through failed save/get',async({page,opts,posts})=>{
 await delay(850);opts.offline=true;
 const entry={
   id:'preserve-memo-editor',entry_type:'note',date:'2026-11-20',hour_slot:'09',
   title:'添付付き既存メモ',body:'編集前の本文\n[[future:保全|v1]]\n[[att:attachment-preserve|日本語.pdf|application/pdf]]',
   tags:'保持,試験',created_at:'2026-11-20 09:00',updated_at:'2026-11-20 09:01',
   deleted:0,claude_taken:'2026-11-20 09:15',pinned:1,sort_order:40,archived:0,
   future_metadata:{zero:0,flag:false,text:'未知の項目'},
 };
 await page.evaluate(entry=>localStorage.setItem('sth_v3_memo_all',JSON.stringify([entry])),entry);
 await page.click('[data-tab="memo"]');
 const row=page.locator('.memo-row[data-id="preserve-memo-editor"]');await row.waitFor();
 // Complete the failed initial GET before permitting synthetic POST responses.
 await page.evaluate(async()=> (await import('/js/memo.js')).pullAndRender());
 assert.equal(await row.count(),1,'failed initial GET keeps cached memo');
 await row.click();
 assert.equal(await memoValue(page),'編集前の本文\n[[future:保全|v1]]');
 assert.equal(await page.locator('.memo-att-file').textContent(),'📎 日本語.pdf');
 assert((await page.locator('.memo-detail-time').textContent()).includes('取込済'));
 opts.offline=false;opts.failPosts=true;opts.postDelay=0;
 const start=posts.length;
 const text='追記後の本文\n[[future:保全|v1]]';
 const body=text+'\n[[att:attachment-preserve|日本語.pdf|application/pdf]]';
 await memoInput(page).fill(text);
 await delay(200);
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('sth_v3_memo_all'))[0].body),entry.body,'autosave remains debounced');
 // Poll IndexedDB from Node: waitForFunction treats the Promise itself as truthy.
 let queued=false;
 for(let attempt=0;attempt<100;attempt++){
   queued=await page.evaluate(async({id,body})=>{
     const rows=await(await import('/js/outbox.js')).listAll();
     return rows.some(row=>row.op.type==='memo_upsert'&&row.op.payload.id===id&&row.op.payload.body===body);
   },{id:entry.id,body});
   if(queued)break;
   await delay(50);
 }
 assert(queued,'autosave must persist the edited memo to outbox');
 const saved=await page.evaluate(async id=>({
   entry:JSON.parse(localStorage.getItem('sth_v3_memo_all')).find(e=>e.id===id),
   rows:await(await import('/js/outbox.js')).listAll(),
 }),entry.id);
 const expected={...entry,body,updated_at:saved.entry.updated_at};
 assert.deepStrictEqual(saved.entry,expected,'editing preserves all unrelated known and unknown metadata');
 assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(saved.entry.updated_at));
 assert.equal(saved.rows.length,1);assert.equal(saved.rows[0].op.type,'memo_upsert');
 assert.deepStrictEqual(saved.rows[0].op.payload,expected,'failed API save queues the complete preserved memo');
 // A durable outbox row is visible before queue-first sending starts on its timer.
 await until(()=>posts.slice(start).some(post=>post.type==='memo_upsert'&&post.entry.id===entry.id&&post.entry.body===body),'durably queued memo reaches its synthetic failed API attempt');
 const sent=posts.slice(start);assert.equal(sent.length,1);assert.equal(sent[0].type,'memo_upsert');
 assert.deepStrictEqual(sent[0].entry,expected);
 opts.offline=true;
 await page.click('#d-back');await row.waitFor();
 await page.evaluate(async()=> (await import('/js/memo.js')).pullAndRender());
 assert.equal(await row.count(),1,'failed refresh GET must not clear cached list');
 assert.equal(await row.locator('.memo-row-title').textContent(),entry.title);
 assert.equal(await row.locator('.memo-pin-icon').count(),1);
 const after=await page.evaluate(async()=>({
   entries:JSON.parse(localStorage.getItem('sth_v3_memo_all')),
   rows:await(await import('/js/outbox.js')).listAll(),
 }));
 assert.deepStrictEqual(after.entries,[expected]);assert.deepStrictEqual(after.rows,saved.rows,'failed refresh retains original outbox identity and payload');
 });

 // Exercise attachment UI through real FileReader/canvas/object URLs and CacheStorage.
 // Specific synthetic responses are supplied at page level; unrelated requests fall
 // back to the harness context route, which never forwards external requests.
 await scenario('image attachment upload, remote reload, and offline cache survive module extraction',async({page,opts,base})=>{
 await delay(850);opts.getDelay=0;
 const attachmentId='preserve-image-attachment';
 let uploaded=null,savedMemo=null,attachmentGets=0;
 const memoWrites=[];
 const headers={'Access-Control-Allow-Origin':'*'};
 await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.hostname!=='script.google.com')return route.fallback();
   const data=request.method()==='POST'?JSON.parse(request.postData()):Object.fromEntries(url.searchParams);
   if(data.type==='memo_attach_get'){
     attachmentGets++;
     if(opts.offline)return route.abort();
     assert.equal(data.id,attachmentId);assert(uploaded,'image was uploaded before downloading');
     return route.fulfill({json:{ok:true,data:{id:attachmentId,name:uploaded.name,mime:uploaded.mime,data:uploaded.data}},headers});
   }
   if(!['memo_attach','memo_upsert','memo_all'].includes(data.type))return route.fallback();
   if(opts.offline)return route.abort();
   if(data.type==='memo_attach'){
     assert.equal(request.method(),'POST');uploaded=data;
     return route.fulfill({json:{ok:true,data:{id:attachmentId,name:data.name,mime:data.mime}},headers});
   }
   if(data.type==='memo_upsert'){
     assert.equal(request.method(),'POST');savedMemo=data.entry;memoWrites.push(data.entry);
     return route.fulfill({json:{ok:true,data:data.entry},headers});
   }
   return route.fulfill({json:{ok:true,data:{entries:savedMemo?[savedMemo]:[],total:savedMemo?1:0}},headers});
 });
 // Poll in Node, awaiting each evaluate result. Do not use async waitForFunction.
 async function until(check,message){
   const deadline=Date.now()+5000;
   while(Date.now()<deadline){if(await check())return;await delay(50);}
   assert.fail(message);
 }
 async function imageSize(){
   return page.locator('.memo-att-img').evaluateAll(images=>images.map(img=>({
     complete:img.complete,width:img.naturalWidth,height:img.naturalHeight,
   })));
 }
 async function waitForImage(){
   await until(async()=>{
     const images=await imageSize();
     return images.length===1&&images[0].complete&&images[0].width===1280&&images[0].height===640;
   },'attachment UI should display the decoded 1280x640 JPEG');
 }
 // Generate an image entirely on localhost; no fixture or image service is needed.
 const png=await page.evaluate(()=>{
   const canvas=document.createElement('canvas');canvas.width=2600;canvas.height=1300;
   const context=canvas.getContext('2d'),gradient=context.createLinearGradient(0,0,2600,1300);
   gradient.addColorStop(0,'#f04a36');gradient.addColorStop(1,'#176bd1');
   context.fillStyle=gradient;context.fillRect(0,0,2600,1300);
   context.fillStyle='#ffffff';context.fillRect(200,200,300,300);
   return canvas.toDataURL('image/png').split(',')[1];
 });
 await page.click('[data-tab="memo"]');await page.locator('#btn-new-memo').waitFor();
 await page.click('#btn-new-memo');await memoInput(page).fill('画像添付の試験');
 await page.locator('#d-file').setInputFiles({name:'縮小試験.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
 const token='[[att:'+attachmentId+'|縮小試験.jpg|image/jpeg]]';
 await until(()=>!!uploaded&&!!savedMemo&&savedMemo.body.includes(token),'attachment upload and memo persistence should complete');
 await until(async()=>{
   const entries=await page.evaluate(()=>JSON.parse(localStorage.getItem('sth_v3_memo_all')||'[]'));
   return entries.some(entry=>entry.id===savedMemo.id&&entry.body==='画像添付の試験\n'+token);
 },'local memo should retain the complete attachment token');
 assert.equal(uploaded.name,'縮小試験.jpg');assert.equal(uploaded.mime,'image/jpeg');
 assert.equal(typeof uploaded.data,'string');
 const jpeg=Buffer.from(uploaded.data,'base64');
 assert(jpeg.length>0&&jpeg.length<3*1024*1024);assert.deepStrictEqual([...jpeg.subarray(0,3)],[255,216,255]);
 assert(memoWrites.some(entry=>entry.body==='画像添付の試験\n'+token));
 await waitForImage();assert.equal(attachmentGets,0,'fresh upload should use its in-memory object URL');
 // Keep a local fixture for every new document. The harness still controls which
 // tab opens; this script only restores memo_all, including during offline startup.
 await page.evaluate(memo=>localStorage.setItem('test:attachment-memo-fixture',JSON.stringify(memo)),savedMemo);
 await page.addInitScript(()=>{
   const raw=localStorage.getItem('test:attachment-memo-fixture');
   if(raw)localStorage.setItem('sth_v3_memo_all',JSON.stringify([JSON.parse(raw)]));
 });
 const memoId=savedMemo.id;
 await page.reload();await page.locator('[data-id="count"] input').waitFor();
 await page.click('[data-tab="memo"]');await page.locator('.memo-row[data-id="'+memoId+'"]').click();
 await waitForImage();assert.equal(attachmentGets,1,'first reload should download the attachment once');
 const cached=await page.evaluate(async id=>{
   const cache=await caches.open('sth-att'),response=await cache.match('/_att/'+id);
   if(!response)return null;
   const blob=await response.blob();
   return {mime:blob.type,size:blob.size,prefix:[...new Uint8Array(await blob.arrayBuffer()).slice(0,3)]};
 },attachmentId);
 assert.deepStrictEqual(cached,{mime:'image/jpeg',size:jpeg.length,prefix:[255,216,255]});
 // Reload clears the module's in-memory URL map; a visible image now proves that
 // the persisted cache works, rather than merely reusing the first document's Map.
 opts.offline=true;
 await page.reload();await page.locator('[data-id="count"] input').waitFor();
 await page.click('[data-tab="memo"]');await page.locator('.memo-row[data-id="'+memoId+'"]').click();
 await waitForImage();assert.equal(attachmentGets,1,'offline reload must use sth-att without another attachment GET');
 assert.equal(await memoValue(page),'画像添付の試験');
 assert.deepStrictEqual(await imageSize(),[{complete:true,width:1280,height:640}]);
 const body=await page.evaluate(id=>JSON.parse(localStorage.getItem('sth_v3_memo_all')).find(entry=>entry.id===id).body,memoId);
 assert.equal(body,'画像添付の試験\n'+token);
 });

 await browser.close();server.close();process.exitCode=failures?1:0;
})().catch(async e=>{console.error(e);await browser?.close();server.close();process.exitCode=1;});
