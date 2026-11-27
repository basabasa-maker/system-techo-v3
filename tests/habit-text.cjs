// Localhost + synthetic fixtures only. No production account or Health data.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const pw=require(process.env.PLAYWRIGHT_PATH||'playwright'),root=process.env.APP_ROOT||path.resolve(__dirname,'..');
const engine=process.env.HABIT_ENGINE||'chromium',output=process.env.HABIT_ARTIFACT_DIR||'/tmp/system-techo-habit-text';
fs.mkdirSync(output,{recursive:true});
const TODAY='2027-01-15',PREV='2027-01-14',clone=x=>JSON.parse(JSON.stringify(x)),delay=ms=>new Promise(r=>setTimeout(r,ms));
const ITEMS=[{id:'journal',label:'一日の記録',icon:'📝',type:'text',unit:'',future:{zero:0,flag:false}},{id:'count',label:'数値',icon:'•',type:'integer',unit:'件',unknown:'keep'},{id:'check',label:'確認',icon:'•',type:'check',unit:''},{id:'clock',label:'時刻',icon:'•',type:'time',unit:''}];
const ORIGINAL={journal:'既存の記録\n行末空白  \n\n',count:0,check:true,clock:'08:30',future:{zero:0,flag:false}};
const text=page=>page.locator('[data-id="journal"] textarea');
const local=(page,date=TODAY)=>page.evaluate(date=>JSON.parse(localStorage.getItem('sth_v3_habitday_'+date)||'{}'),date);
async function until(check,message,ms=8000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await delay(25);}assert.fail(message);}
const server=http.createServer((req,res)=>{const file=path.resolve(root,'.'+(req.url.split('?')[0]==='/'?'/index.html':decodeURIComponent(req.url.split('?')[0])));if(!file.startsWith(root+path.sep))return res.writeHead(403).end();fs.readFile(file,(e,b)=>{if(e)return res.writeHead(404).end();res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png'})[path.extname(file)]||'text/html');res.end(b);});});
let browser,base,passed=0,failed=0;const cases=[],observations={};
async function scenario(name,fn){
 if(process.env.HABIT_TEST&&!name.includes(process.env.HABIT_TEST))return;
 let context;
 try{
  context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block',...(engine==='webkit'?{userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1'}:{})});
  const page=await context.newPage();page.setDefaultTimeout(3500);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const posts=[],gets=[],remote=new Map([[TODAY,clone(ORIGINAL)],[PREV,{journal:'前日の記録',count:7,clock:'07:00',future:'other day'}]]);
  let remoteItems=clone(ITEMS);const opts={offline:false,failPosts:false,dayDelay:0,rangeDelay:0};
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());if(url.origin===base)return route.continue();if(url.hostname!=='script.google.com'||opts.offline)return route.abort();
   const p=request.method()==='POST'?JSON.parse(request.postData()):Object.fromEntries(url.searchParams);
   if(request.method()==='POST'){
    posts.push(clone(p));if(opts.failPosts)return route.fulfill({json:{ok:false,error:'synthetic unavailable'}});
    if(p.type==='habit_day_upsert'){const v={...(remote.get(p.date)||{}),...p.set};for(const id of p.del||[])delete v[id];remote.set(p.date,v);}
    if(p.type==='habit_items_upsert')remoteItems=clone(p.items);
    return route.fulfill({json:{ok:true,data:{}}});
   }
   gets.push(clone(p));let data={items:[],values:{},days:{},tasks:[],entries:[],nodes:[],boards:[],board_items:[],events:[]};
   if(p.type==='habit_items')data.items=clone(remoteItems);
   if(p.type==='habit_day'){data.values=clone(remote.get(p.date)||{});await delay(opts.dayDelay);}
   if(p.type==='habit_range'){data.days=Object.fromEntries([...remote].map(([d,v])=>[d,clone(v)]));await delay(opts.rangeDelay);}
   return route.fulfill({json:{ok:true,data}});
  });
  await page.clock.setFixedTime(new Date(TODAY+'T12:00:00Z'));
  await page.addInitScript(({items,original,today,prev})=>{if(localStorage.getItem('habit-text:seeded'))return;localStorage.setItem('habit-text:seeded','1');localStorage.setItem('sth_v3_cache_schema','4');localStorage.setItem('sth_v3_active_tab','habit');localStorage.setItem('sth_v3_habit_items',JSON.stringify(items));localStorage.setItem('sth_v3_habitday_'+today,JSON.stringify(original));localStorage.setItem('sth_v3_habitday_'+prev,JSON.stringify({journal:'前日の記録',count:7,clock:'07:00',future:'other day'}));localStorage.setItem('habit-text:unrelated',' { "keep":[0,false] } ');},{items:ITEMS,original:ORIGINAL,today:TODAY,prev:PREV});
  await page.goto(base);await page.locator('#h-add').waitFor();await until(()=>gets.some(p=>p.type==='habit_day'),'initial day read');await delay(120);
  await fn({page,posts,gets,opts,remote});
  assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>localStorage.getItem('habit-text:unrelated')),' { "keep":[0,false] } ');
  cases.push({name,result:'passed'});passed++;console.log('PASS',engine,name);
 }catch(e){cases.push({name,result:'failed',error:e.message});failed++;console.log('FAIL',engine,name,e.stack||e.message);}finally{await context?.close();}
}
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
 browser=await pw[engine].launch(engine==='chromium'?{headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{headless:true});
 await scenario('offers a multiline text input type for a new habit item',async({page,posts})=>{
  await page.locator('#h-add').click();assert.equal(await page.locator('#e-type option[value="text"]').count(),1);
  await page.locator('#e-label').fill('感想');await page.locator('#e-type').selectOption('text');await page.locator('#e-save').click();
  await until(()=>posts.some(p=>p.type==='habit_items_upsert'&&p.items.some(i=>i.type==='text'&&i.label==='感想')),'new text item is queued');assert.equal(await page.locator('textarea').count(),2);
 });
 await scenario('existing multiline text opens unchanged without writes and uses a modest 16px textarea',async({page,posts})=>{
  await text(page).waitFor();assert.equal(await text(page).inputValue(),ORIGINAL.journal);
  const m=await text(page).evaluate(el=>({font:getComputedStyle(el).fontSize,rows:el.rows,height:el.getBoundingClientRect().height,userSelect:getComputedStyle(el).getPropertyValue('user-select')||getComputedStyle(el).getPropertyValue('-webkit-user-select'),color:getComputedStyle(el).color,foreground:getComputedStyle(document.body).color}));
  observations.textarea=m;assert.equal(m.font,'16px');assert.equal(m.userSelect,'text','native textarea permits selection/copy');assert.equal(m.color,m.foreground,'text uses the existing foreground theme color');assert(m.rows>=3&&m.height<220);assert.deepEqual(await local(page),ORIGINAL);assert.equal(posts.length,0);
 });
 await scenario('editing an existing habit retains unknown metadata',async({page,posts})=>{
  await page.locator('#h-edit').click();await page.locator('[data-id="count"] .habit-label').click();await page.locator('#e-label').fill('数値を改名');await page.locator('#e-save').click();
  await until(()=>posts.some(p=>p.type==='habit_items_upsert'),'item edit reaches queue');
  const changed=posts.find(p=>p.type==='habit_items_upsert').items.find(i=>i.id==='count');assert.deepEqual(changed,{...ITEMS[1],label:'数値を改名'});
  assert.deepEqual(await local(page),ORIGINAL);
 });
 await scenario('text input preserves whitespace HTML literals and sends only its day/id PATCH',async({page,posts,remote})=>{
  await text(page).fill('記録🙂\n<img src=x onerror=alert(1)>\n  末尾  \n');
  await until(()=>remote.get(TODAY).journal==='記録🙂\n<img src=x onerror=alert(1)>\n  末尾  \n','text PATCH arrives');
  const writes=posts.filter(p=>p.type==='habit_day_upsert');assert(writes.length>0);
  for(const p of writes){assert.equal(p.date,TODAY);assert.deepEqual(Object.keys(p.set),['journal']);assert.deepEqual(p.del,[]);assert(!('values'in p));}
  assert.deepEqual(await local(page),{...ORIGINAL,journal:remote.get(TODAY).journal});assert.equal(await page.locator('.habit-item img[src="x"]').count(),0);
 });
 await scenario('Enter and composing Enter retain focus and multiline content without replacing the field',async({page})=>{
  await text(page).fill('一行目');await text(page).press('End');await text(page).press('Enter');await page.keyboard.insertText('二行目');
  assert.equal(await text(page).inputValue(),'一行目\n二行目');assert(await text(page).evaluate(el=>el===document.activeElement));
  await text(page).evaluate(el=>{window.habitTextInput=el;el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));});
  assert(await text(page).evaluate(el=>el===window.habitTextInput&&el===document.activeElement));
  await text(page).dispatchEvent('compositionend');await until(async()=>(await local(page)).journal==='一行目\n二行目','multiline committed');
 });
 await scenario('date and tab switching preserve the edited text and never alter another day',async({page})=>{
  await text(page).fill('今日だけの文\n続き');await page.locator('#h-prev').click();assert.equal(await text(page).inputValue(),'前日の記録');
  await text(page).fill('前日だけの追記');await page.locator('[data-tab="task"]').click();await page.locator('[data-tab="habit"]').click();assert.equal(await text(page).inputValue(),'前日だけの追記');
  await page.locator('#h-next').click();assert.equal(await text(page).inputValue(),'今日だけの文\n続き');
  assert.equal((await local(page,PREV)).journal,'前日だけの追記');assert.equal((await local(page)).count,0);assert.equal((await local(page,PREV)).count,7);
 });
 await scenario('late detached composition/input events stay bound to their original day',async({page})=>{
  const old=await text(page).elementHandle();await page.locator('#h-prev').click();await text(page).waitFor();
  await old.evaluate(el=>{el.value='遅れて確定した元の日の文';el.dispatchEvent(new InputEvent('input',{bubbles:true,data:'文',isComposing:true}));el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));});
  await until(async()=>(await local(page)).journal==='遅れて確定した元の日の文','old day text is retained');assert.equal((await local(page,PREV)).journal,'前日の記録');assert.equal(await text(page).inputValue(),'前日の記録');
 });
 await scenario('late GET cannot replace a text edit even after its PATCH has finished',async({page,opts,remote})=>{
  opts.dayDelay=800;await page.evaluate(()=>{window.habitTextRefresh=import('/js/habit.js').then(m=>m.pullAndRender());});await delay(80);
  await text(page).fill('遅い取得より新しい本文');await text(page).blur();await until(()=>remote.get(TODAY).journal==='遅い取得より新しい本文','edit was sent');await page.evaluate(()=>window.habitTextRefresh);
  assert.equal((await local(page)).journal,'遅い取得より新しい本文');assert.equal(await text(page).inputValue(),'遅い取得より新しい本文');
 });
 await scenario('pending daily writes survive history range loading',async({page,opts})=>{
  opts.failPosts=true;await page.evaluate(async({date})=>{const key='sth_v3_habitday_'+date;const v=JSON.parse(localStorage.getItem(key));v.journal='未送信の本文';localStorage.setItem(key,JSON.stringify(v));await(await import('/js/sync.js')).queue({type:'habit_day_upsert',payload:{date,set:{journal:v.journal},del:[]}});},{date:TODAY});
  await page.locator('[data-sub="hist"]').click();await page.locator('.hist-row').first().waitFor();assert.equal((await local(page)).journal,'未送信の本文');
 });
 await scenario('in-flight history GET cannot overwrite a newly saved text value',async({page,opts,remote})=>{
  opts.rangeDelay=800;await page.evaluate(()=>{window.habitRange=import('/js/habit-stats.js').then(m=>m.loadRange());});await delay(80);
  await text(page).fill('範囲取得より新しい本文');await until(()=>remote.get(TODAY).journal==='範囲取得より新しい本文','new value sent');await page.evaluate(()=>window.habitRange);assert.equal((await local(page)).journal,'範囲取得より新しい本文');
 });
 await scenario('history safely displays text and its line breaks',async({page,remote})=>{
  remote.get(TODAY).journal='<b>文字</b>\n二行目';await page.locator('[data-sub="hist"]').click();const row=page.locator('.hist-row[data-date="'+TODAY+'"]');await row.waitFor();
  assert((await row.textContent()).includes('<b>文字</b>\n二行目'));assert.equal(await row.locator('b').count(),0);assert(['pre-wrap','break-spaces'].includes(await row.locator('.hist-text').evaluate(el=>getComputedStyle(el).whiteSpace)));
 });
 await scenario('offline text and unrelated fields survive reload then replay',async({page,opts,remote})=>{
  opts.offline=true;await text(page).fill('オフライン🙂\nそのまま');
  await until(async()=>(await page.evaluate(async()=>(await import('/js/outbox.js')).listAll())).some(r=>r.op.payload?.set?.journal==='オフライン🙂\nそのまま'),'text is durable in outbox');
  await page.reload();await text(page).waitFor();assert.equal(await text(page).inputValue(),'オフライン🙂\nそのまま');opts.offline=false;await page.evaluate(async()=>(await import('/js/sync.js')).flushAll());
  assert.equal(remote.get(TODAY).journal,'オフライン🙂\nそのまま');assert.equal((await local(page)).clock,'08:30');assert.equal((await local(page)).check,true);
 });
 await scenario('clearing text deletes only that key and preserves other dates and types',async({page,posts})=>{
  await text(page).waitFor();await page.locator('[data-id="journal"] .habit-clear').click();
  await until(()=>posts.some(p=>p.type==='habit_day_upsert'&&p.del.includes('journal')),'clear text PATCH arrives');
  assert.deepEqual(await local(page),Object.fromEntries(Object.entries(ORIGINAL).filter(([k])=>k!=='journal')));assert.equal((await local(page,PREV)).journal,'前日の記録');
 });
 await scenario('local cache failure keeps the visible text for a successful retry',async({page,posts})=>{
  await text(page).waitFor();await page.evaluate(({date})=>{const set=Storage.prototype.setItem;window.restoreHabitTextStorage=()=>Storage.prototype.setItem=set;Storage.prototype.setItem=function(k,v){if(this===localStorage&&k==='sth_v3_habitday_'+date)throw new DOMException('synthetic quota','QuotaExceededError');return set.call(this,k,v);};},{date:TODAY});
  await text(page).fill('保存を再試行する本文');assert.equal(await page.evaluate(async()=>(await import('/js/habit.js')).hasUnsavedHabitText()),true);assert.equal(await text(page).inputValue(),'保存を再試行する本文');assert.equal((await local(page)).journal,ORIGINAL.journal);assert.equal(posts.filter(p=>p.type==='habit_day_upsert').length,0);
  await page.evaluate(()=>window.restoreHabitTextStorage());await text(page).blur();await until(async()=>(await local(page)).journal==='保存を再試行する本文','retry persists the same visible text');assert.equal(await page.evaluate(async()=>(await import('/js/habit.js')).hasUnsavedHabitText()),false);
 });
 for(const erase of [false,true])await scenario('enqueue rejection protects text '+(erase?'deletion':'edit')+' across reload',async({page,remote})=>{
  await text(page).waitFor();
  await page.evaluate(()=>{const add=IDBObjectStore.prototype.add;IDBObjectStore.prototype.add=function(v,...rest){if(this.name==='outbox'&&v?.op?.type==='habit_day_upsert')throw new DOMException('synthetic enqueue failure','UnknownError');return add.call(this,v,...rest);};});
  if(erase)await page.locator('[data-id="journal"] .habit-clear').click();else await text(page).fill('キュー失敗後も残す本文');
  await until(async()=>erase?!Object.hasOwn(await local(page),'journal'):(await local(page)).journal==='キュー失敗後も残す本文','local text edit is preserved before leaving');
  await page.locator('[data-tab="task"]').click();await page.reload();await page.locator('[data-tab="habit"]').click();await text(page).waitFor();await delay(1100);
  const current=await local(page);if(erase)assert(!Object.hasOwn(current,'journal'),'old GET must not resurrect cleared text');else assert.equal(current.journal,'キュー失敗後も残す本文','old GET must not overwrite locally saved text');
  await until(()=>erase?!Object.hasOwn(remote.get(TODAY),'journal'):remote.get(TODAY).journal==='キュー失敗後も残す本文','recovery replays only the protected text patch');
  assert.equal(current.count,0);assert.equal(current.clock,'08:30');
 });
 await scenario('additional local cache failure blocks date and tab departure without losing the field',async({page})=>{
  await text(page).waitFor();await page.evaluate(({date})=>{window.failedTextNode=document.querySelector('textarea');const original=Storage.prototype.setItem;window.restoreHabitTextStorage=()=>Storage.prototype.setItem=original;Storage.prototype.setItem=function(k,v){if(this===localStorage&&k==='sth_v3_habitday_'+date)throw new DOMException('synthetic quota','QuotaExceededError');return original.call(this,k,v);};},{date:TODAY});
  await text(page).fill('離脱前に残す本文');await page.locator('#h-prev').click();assert.equal(await text(page).inputValue(),'離脱前に残す本文');
  await page.locator('[data-tab="task"]').click();assert(await text(page).evaluate(el=>el===window.failedTextNode&&el.isConnected));assert.equal(await page.locator('[data-tab="habit"].active').count(),1);
  await page.evaluate(()=>window.restoreHabitTextStorage());await page.locator('#h-prev').click();assert.equal(await text(page).inputValue(),'前日の記録');assert.equal((await local(page)).journal,'離脱前に残す本文');
 });
 await scenario('additional no-op textarea preserves raw CRLF leading blank lines and whitespace',async({page,posts,remote})=>{
  const body='\n先頭を空行にする\r\n末尾空白  \r\n\r\n';remote.get(TODAY).journal=body;
  await page.evaluate(({date,body})=>{const k='sth_v3_habitday_'+date,v=JSON.parse(localStorage.getItem(k));v.journal=body;localStorage.setItem(k,JSON.stringify(v));},{date:TODAY,body});
  await page.reload();await text(page).waitFor();assert.equal(await text(page).inputValue(),body.replaceAll('\r\n','\n'));await text(page).focus();await text(page).blur();await delay(800);
  assert.equal((await local(page)).journal,body);assert.equal(posts.filter(p=>p.type==='habit_day_upsert').length,0);
 });
 await scenario('additional rapid text edits are durable immediately and debounce only network sending',async({page,posts,remote})=>{
  await text(page).fill('文');await delay(60);await text(page).fill('文章');await delay(60);await text(page).fill('文章の最終値');
  assert.equal((await local(page)).journal,'文章の最終値');
  const rows=await page.evaluate(async()=>(await import('/js/outbox.js')).listAll());assert(rows.some(r=>r.op.payload?.set?.journal==='文章の最終値'));await delay(220);
  assert.equal(posts.filter(p=>p.type==='habit_day_upsert').length,0,'text remains queued during the700ms debounce');
  await until(()=>remote.get(TODAY).journal==='文章の最終値','debounced text reaches server');assert.deepEqual(posts.filter(p=>p.type==='habit_day_upsert').map(p=>p.set),[{journal:'文章の最終値'}]);
 });
 await scenario('additional changing an old numeric item to text keeps its zero until the user edits',async({page,posts})=>{
  await page.locator('#h-edit').click();await page.locator('[data-id="count"] .habit-label').click();await page.locator('#e-type').selectOption('text');await page.locator('#e-save').click();
  const field=page.locator('[data-id="count"] textarea');await field.waitFor();assert.equal(await field.inputValue(),'0');await field.focus();await field.blur();assert.equal((await local(page)).count,0);
  assert.equal(posts.filter(p=>p.type==='habit_day_upsert').length,0);const cached=await page.evaluate(()=>JSON.parse(localStorage.getItem('sth_v3_habit_items')).find(i=>i.id==='count'));assert.equal(cached.unknown,'keep');assert.equal(cached.type,'text');
 });
 await scenario('late old text session cannot roll back a newer edit of the same day and item',async({page,remote})=>{
  const old=await text(page).elementHandle();await page.locator('[data-tab="task"]').click();await page.locator('[data-tab="habit"]').click();await text(page).waitFor();
  await text(page).fill('開き直した後の新しい本文');await until(()=>remote.get(TODAY).journal==='開き直した後の新しい本文','new session edit is saved');
  await old.evaluate(el=>{el.value='旧画面から遅れて来た未確定文';el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));});
  assert.equal((await local(page)).journal,'開き直した後の新しい本文','detached older session cannot overwrite the newer edit');assert.equal(await text(page).inputValue(),'開き直した後の新しい本文');
 });
 await scenario('recovery refuses a stale cache after day write and marker rollback both fail',async({page,remote,posts})=>{
  remote.get(TODAY).journal='サーバー側の新しい記録';
  await page.evaluate(({date})=>{
   const original=Storage.prototype.setItem;let markerWrites=0;window.restoreHabitTextStorage=()=>Storage.prototype.setItem=original;
   Storage.prototype.setItem=function(k,v){if(this===localStorage&&k==='sth_v3_habit_text_recovery'&&++markerWrites===2)throw new DOMException('synthetic marker rollback failure','QuotaExceededError');if(this===localStorage&&k==='sth_v3_habitday_'+date)throw new DOMException('synthetic day failure','QuotaExceededError');return original.call(this,k,v);};
  },{date:TODAY});
  await text(page).fill('保存したかった新しい文章');assert.equal((await local(page)).journal,ORIGINAL.journal);
  await page.evaluate(()=>window.restoreHabitTextStorage());
  const error=await page.evaluate(async()=>{try{await(await import('/js/habit/text.js')).replayHabitTextRecovery();return null;}catch(e){return e.message;}});
  await delay(850);observations.rollbackFailureReplay={error,sent:posts.filter(p=>p.type==='habit_day_upsert').map(p=>p.set)};
  assert(error,'mismatched intended value must stop replay');assert.equal(posts.filter(p=>p.type==='habit_day_upsert').length,0,'stale cache must never be sent as the attempted new value');assert.equal(remote.get(TODAY).journal,'サーバー側の新しい記録');
 });
 await scenario('image icons offer twenty new and fifty legacy selectable options',async({page,posts})=>{
  await page.locator('#h-add').click();assert.equal(await page.locator('.icon-opt').count(),70);assert.equal(await page.locator('.habit-image-grid .icon-opt').count(),20);
  const selected=await page.locator('.icon-opt').evaluateAll(buttons=>buttons.map(button=>{button.click();return button.classList.contains('sel')&&button.getAttribute('aria-pressed')==='true'&&document.querySelectorAll('.icon-opt.sel').length===1;}));assert(selected.every(Boolean));assert.equal(posts.length,0);
  const styles=await page.locator('.icon-opt').evaluateAll(buttons=>buttons.map(button=>{const s=getComputedStyle(button),r=button.getBoundingClientRect();return{width:r.width,height:r.height,font:s.fontSize,background:s.backgroundColor};}));
  assert(styles.every(s=>s.background==='rgb(255, 255, 255)'), 'new and existing picker backgrounds are white');
  observations.iconPickerStyles=styles;
  assert(styles.every(s=>Math.abs(s.width-styles[0].width)<0.1&&s.height===styles[0].height&&s.font===styles[0].font), 'all seventy options share the existing picker geometry and font');
  const imageSize=await page.locator('.habit-image-icon').first().evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}));
  assert.deepEqual(imageSize,{width:22,height:22},'image frame compensates for white padding rather than using the previous oversized 36px tile');
  await page.locator('[data-ic="habit-image:writing"]').click();
  const border=await page.locator('[data-ic="habit-image:writing"]').evaluate(el=>({style:getComputedStyle(el).borderTopStyle,width:getComputedStyle(el).borderTopWidth}));assert.deepEqual(border,{style:'solid',width:'2px'});
  assert(await page.locator('.habit-image-grid').evaluate(el=>el.clientHeight>=el.scrollHeight),'all twenty image options fit inside their unshrunk grid');
  for(const width of [320,390])for(const kind of ['dark','light']){await page.setViewportSize({width,height:844});await page.evaluate(async kind=>{(await import('/js/theme.js')).applyTheme(kind==='light'?'cream':'navy');document.querySelector('.modal-body').scrollTop=0;},kind);await delay(60);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,engine+'-icons-'+width+'-'+kind+'.png')});}
  await page.locator('#e-cancel').click();assert.deepEqual(await local(page),ORIGINAL);
 });
 await scenario('image icon selected on a new text item survives reopening its editor',async({page})=>{
  await page.locator('#h-add').click();await page.locator('[data-ic="habit-image:writing"]').click();await page.locator('#e-label').fill('画像付きの文章');await page.locator('#e-type').selectOption('text');await page.locator('#e-save').click();
  const item=await page.evaluate(()=>JSON.parse(localStorage.getItem('sth_v3_habit_items')).find(i=>i.label==='画像付きの文章'));assert.equal(item.icon,'habit-image:writing');assert.equal(item.type,'text');
  await page.locator('#h-edit').click();await page.locator('[data-id="'+item.id+'"] .habit-label').click();assert.equal(await page.locator('[data-ic="habit-image:writing"].sel').count(),1);assert.equal(await page.locator('#e-type').inputValue(),'text');await page.locator('#e-cancel').click();assert.deepEqual(await local(page),ORIGINAL);
 });
 await scenario('image change preserves the existing id metadata and every old daily value',async({page,posts})=>{
  const previous=await local(page,PREV);await page.locator('#h-edit').click();await page.locator('[data-id="count"] .habit-label').click();await page.locator('[data-ic="habit-image:bicycle"]').click();await page.locator('#e-save').click();
  const item=await page.evaluate(()=>JSON.parse(localStorage.getItem('sth_v3_habit_items')).find(i=>i.id==='count'));assert.deepEqual(item,{...ITEMS[1],icon:'habit-image:bicycle'});assert.deepEqual(await local(page),ORIGINAL);assert.deepEqual(await local(page,PREV),previous);assert.equal(posts.filter(p=>p.type==='habit_day_upsert').length,0);
 });
 await scenario('image artwork update reuses all twenty stored IDs without changing records',async({page,opts})=>{
  opts.offline=true;
  const original=await local(page),previous=await local(page,PREV);
  const stored=await page.evaluate(async()=>{
   const {IMAGE_HABIT_ICONS}=await import('/js/habit/icons.js');
   const items=[...JSON.parse(localStorage.getItem('sth_v3_habit_items')),...IMAGE_HABIT_ICONS.map((icon,index)=>({id:'saved-image-'+index,label:icon.label,icon:icon.id,type:'integer',unit:'回',unknown:{keep:true}}))];
   const raw=JSON.stringify(items);localStorage.setItem('sth_v3_habit_items',raw);return raw;
  });
  await page.reload();await until(async()=>await page.locator('.habit-list .habit-image-icon').count()===20,'all saved image IDs render the replacement artwork');
  const rowStyles=()=>page.locator('.habit-icon').evaluateAll(elements=>elements.map(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return{width:r.width,height:r.height,font:s.fontSize,background:s.backgroundColor};}));
  observations.iconRowStyles=await rowStyles();
  assert(observations.iconRowStyles.every(s=>s.width===28&&s.height===30&&s.font==='22px'&&s.background==='rgb(255, 255, 255)'),'new and legacy row frames share white backgrounds and existing 22px type');
  for(const kind of ['navy','cream']){await page.evaluate(async kind=>(await import('/js/theme.js')).applyTheme(kind),kind);await page.screenshot({path:path.join(output,engine+'-icon-rows-'+kind+'.png')});}
  await page.locator('#h-edit').click();assert.deepEqual(await rowStyles(),observations.iconRowStyles,'edit mode preserves the same icon dimensions');
  assert.equal(await page.evaluate(()=>localStorage.getItem('sth_v3_habit_items')),stored,'existing twenty IDs and unknown metadata are byte-for-byte unchanged');
  assert.deepEqual(await local(page),original);assert.deepEqual(await local(page,PREV),previous);
 });
 await scenario('late text session cannot replace a newer checkbox value after changing its type',async({page})=>{
  const old=await text(page).elementHandle();await page.locator('#h-edit').click();await page.locator('[data-id="journal"] .habit-label').click();await page.locator('#e-type').selectOption('check');await page.locator('#e-save').click();
  await page.locator('[data-id="journal"] .habit-check').click();await until(async()=>(await local(page)).journal===true,'new checkbox value is saved');
  await old.evaluate(el=>{el.value='型変更前からの遅い文章';el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));});
  observations.changedTypeLateEvent={value:(await local(page)).journal};assert.equal((await local(page)).journal,true,'old text session cannot replace the newly recorded checkbox value');
 });
 fs.writeFileSync(path.join(output,engine+(process.env.HABIT_TEST?'-'+process.env.HABIT_TEST.replace(/[^a-z0-9]+/gi,'-').toLowerCase():'')+'-results.json'),JSON.stringify({engine,passed,failed,cases,observations,isolatedLocalOnly:true,actualIPhoneKeyboard:false},null,2)+'\n');
 await browser.close();server.close();console.log(passed+' passed / '+failed+' failed');process.exitCode=failed?1:0;
})().catch(async e=>{console.error(e);await browser?.close();server.close();process.exitCode=1;});
