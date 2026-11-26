// Isolated browser/editor QA. All API replies, memos and attachments are synthetic.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const playwright = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const root = process.env.APP_ROOT || path.resolve(__dirname, '..');
const engine = process.env.MEMO_ENGINE || 'chromium';
const IOS_USER_AGENT='Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1';
const output = process.env.MEMO_ARTIFACT_DIR || '/tmp/system-techo-memo-focus-qa';
fs.mkdirSync(output, { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const clone = value => JSON.parse(JSON.stringify(value));
const fixture = (body, id = 'memo-primary') => ({ id, entry_type: 'note', date: '2026-11-26', hour_slot: '09', title: '合成メモ', body, tags: '検証,保持', created_at: '2026-11-26 09:00', updated_at: '2026-11-26 09:01', deleted: 0, pinned: 1, archived: 0, sort_order: 20, claude_taken: '2026-11-26 09:15', future_metadata: { zero: 0, flag: false } });
const ordinary = () => [fixture('☐ 買い物\n☑ 済みの予定\n通常の本文\n')];
const server = http.createServer((request, response) => {
  const relative = decodeURIComponent(request.url.split('?')[0]);
  const file = path.resolve(root, '.' + (relative === '/' ? '/index.html' : relative));
  if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  fs.readFile(file, (error, bytes) => {
    if (error) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' })[path.extname(file)] || 'text/html');
    response.end(bytes);
  });
});
let browser, base, passed = 0, failed = 0;
const outcomes = [], observations = {};
const editor = page => page.locator('#d-text .cm-content[contenteditable="true"]');
const memoWrites = posts => posts.filter(item => item.type === 'memo_upsert');
async function until(test, message, timeout = 7000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await test()) return; await delay(35); }
  assert.fail(message);
}
async function localMemo(page, id = 'memo-primary') {
  return page.evaluate(id => JSON.parse(localStorage.getItem('sth_v3_memo_all') || '[]').find(entry => entry.id === id), id);
}
async function waitBody(page, expected, id = 'memo-primary') {
  try { await until(async () => (await localMemo(page, id))?.body === expected, 'local memo body must match expected edit'); } catch (error) { throw new Error(error.message + '; actual=' + JSON.stringify((await localMemo(page, id))?.body) + '; expected=' + JSON.stringify(expected)); }
}
async function replaceText(page, text) {
  // Select through the editor's own keymap so hidden checkbox source markers
  // participate. Native DOM fill cannot select contenteditable=false widgets.
  await editor(page).focus(); await editor(page).press('Meta+a');
  await page.keyboard.insertText(text); await delay(50);
}
async function open(page, id = 'memo-primary') {
  await page.locator(`.memo-row[data-id="${id}"]`).click();
  await editor(page).waitFor();
}
async function scenario(name, fn, seed = ordinary(), dimensions = { width: 390, height: 844 }, contextOverrides = {}) {
  if (process.env.MEMO_FOCUS_TEST && !name.includes(process.env.MEMO_FOCUS_TEST)) return;
  let context;
  try {
    context = await browser.newContext({ viewport: dimensions, isMobile: true, hasTouch: true, serviceWorkers: 'block', ...(engine === 'webkit' ? { userAgent: IOS_USER_AGENT } : {}), ...contextOverrides });
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const opts = { offline: false, failPosts: false, getDelay: 0, uploadDelay: 0, postDelay: 0 };
    const posts = [], gets = [], remote = new Map(seed.map(entry => [entry.id, clone(entry)]));
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === base) return route.continue();
      if (url.hostname !== 'script.google.com') return route.abort();
      if (opts.offline) return route.abort();
      const body = request.method() === 'POST' ? JSON.parse(request.postData()) : Object.fromEntries(url.searchParams);
      if (request.method() === 'POST') {
        posts.push(clone(body));
        await delay(body.type === 'memo_attach' ? opts.uploadDelay : typeof opts.postDelay === 'function' ? opts.postDelay(body) : opts.postDelay);
        if (opts.failPosts) return route.fulfill({ json: { ok: false, error: 'synthetic save failure' }, headers: { 'Access-Control-Allow-Origin': '*' } });
        let data = {};
        if (body.type === 'memo_upsert') { data = clone(body.entry); remote.set(data.id, data); }
        if (body.type === 'memo_delete') remote.delete(body.id);
        if (body.type === 'memo_attach') data = { id: 'synthetic-pdf', name: body.name || '資料.pdf', mime: body.mime || 'application/pdf' };
        return route.fulfill({ json: { ok: true, data }, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
      gets.push(body); const snapshot = [...remote.values()].map(clone); await delay(opts.getDelay);
      return route.fulfill({ json: { ok: true, data: { entries: body.type === 'memo_all' ? snapshot : [], tasks: [], items: [], values: {}, days: {}, events: [] } }, headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    await page.addInitScript(entries => {
      if (localStorage.getItem('memo-focus-qa:seeded')) return;
      localStorage.setItem('memo-focus-qa:seeded', '1'); localStorage.setItem('sth_v3_cache_schema', '4'); localStorage.setItem('sth_v3_active_tab', 'memo');
      localStorage.setItem('sth_v3_memo_all', JSON.stringify(entries)); localStorage.setItem('memo-focus-qa:unrelated', ' { "unchanged": [0,false] } ');
    }, seed);
    await page.goto(base); await page.locator('.memo-row').first().waitFor(); await delay(100);
    await fn({ page, opts, posts, gets, remote, seed });
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    assert.equal(await page.evaluate(() => localStorage.getItem('memo-focus-qa:unrelated')), ' { "unchanged": [0,false] } ');
    passed++; outcomes.push({ name, result: 'passed' }); console.log('PASS', engine, name);
    await context.close(); context = null;
  } catch (error) {
    failed++; outcomes.push({ name, result: 'failed', error: error.message }); console.log('FAIL', engine, name, error.stack || error.message);
  } finally { await context?.close(); }
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
  browser = await playwright[engine].launch(engine === 'chromium' ? { headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : { headless: true });

  async function snapshot(page) {
    return page.evaluate(async () => {
      const {EditorView}=await import('/vendor/codemirror/codemirror.js');
      const content=document.querySelector('#d-text .cm-content');
      const view=EditorView.findFromDOM(content), scroll=document.querySelector('#d-text .cm-scroller');
      const rect=element=>{const r=element.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};};
      const main=view.state.selection.main;
      return {rootScroll:document.scrollingElement.scrollTop,outerScroll:document.querySelector('#scroll-container').scrollTop,
        editorScroll:scroll.scrollTop,editorScrollMax:scroll.scrollHeight-scroll.clientHeight,selection:{from:main.from,to:main.to},
        text:view.state.doc.toString(),focus:content===document.activeElement,caret:view.coordsAtPos(main.head),
        visual:{height:visualViewport.height,offsetTop:visualViewport.offsetTop},innerHeight,
        content:rect(content),scroller:rect(scroll),detail:rect(document.querySelector('.memo-detail')),
        minimumHeight:getComputedStyle(content).minHeight,flexGrow:getComputedStyle(content).flexGrow};
    });
  }
  async function recordEvents(page) {
    await page.evaluate(()=>{
      window.memoFocusEvents=[];
      const record=(type,target)=>window.memoFocusEvents.push({type,target:target?.className||target?.nodeName,
        time:performance.now(),documentScroll:document.scrollingElement.scrollTop,editorScroll:document.querySelector('.cm-scroller')?.scrollTop});
      document.addEventListener('scroll',event=>record('scroll',event.target),true);
      document.addEventListener('focusin',event=>record('focusin',event.target),true);
      visualViewport.addEventListener('resize',()=>record('vv.resize',document.documentElement));
      visualViewport.addEventListener('scroll',()=>record('vv.scroll',document.documentElement));
      const original=Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView=function(...args){record('scrollIntoView',this);return original.apply(this,args);};
    });
  }
  async function tapFirstLine(page) {
    const line=await page.locator('#d-text .cm-line').first().boundingBox();
    await page.touchscreen.tap(line.x+Math.min(38,line.width-5),line.y+Math.min(15,line.height-2));
    await delay(600);
  }
  for (const [kind,text] of [['empty',''],['short','短い本文です。\n次の行です。'.replaceAll('\\n','\n')],['long',Array.from({length:100},(_,i)=>String(i+1).padStart(3,'0')+' 日本語🙂の本文です。折り返し行の先頭をタップして入力を保持します。').join('\n')]]) {
    for (const mode of ['native-tap','synthetic-vv-shrink','synthetic-vv-pan']) {
      await scenario(kind+' '+mode+' preserves first-line caret and text',async({page,posts})=>{
        await open(page);await recordEvents(page);const before=await snapshot(page);
        await tapFirstLine(page);const tapped=await snapshot(page);
        const phases=[{phase:'before',...before},{phase:'tapped',...tapped}];
        if(mode!=='native-tap'){
          await page.evaluate(()=>{
            const viewport=visualViewport;
            window.memoFocusVV={height:viewport.height,offsetTop:viewport.offsetTop};
            Object.defineProperty(viewport,'height',{configurable:true,get:()=>window.memoFocusVV.height});
            Object.defineProperty(viewport,'offsetTop',{configurable:true,get:()=>window.memoFocusVV.offsetTop});
          });
          for(const [height,offsetTop,event] of (mode==='synthetic-vv-shrink'?[[650,0,'resize'],[500,0,'resize'],[420,0,'resize']]:[[500,0,'resize'],[420,80,'resize'],[420,120,'scroll']])){
            await page.evaluate(({height,offsetTop,event})=>{Object.assign(window.memoFocusVV,{height,offsetTop});visualViewport.dispatchEvent(new Event(event));},{height,offsetTop,event});
            await delay(160);phases.push({phase:event+' '+height+'/'+offsetTop,...await snapshot(page)});
          }
        }
        observations[kind+' '+mode]={osKeyboard:'not simulated by Playwright',syntheticViewport:mode!=='native-tap',phases,
          events:await page.evaluate(()=>window.memoFocusEvents)};
        const after=await snapshot(page);
        assert.equal(after.text,text,'tap and viewport changes never rewrite memo body');
        assert.equal(memoWrites(posts).length,0,'focus and viewport changes never save');
        assert(after.selection.from<Math.max(1,text.indexOf('\n')<0?text.length:text.indexOf('\n')),'tap keeps caret on the first logical line');
        assert(after.editorScroll<48,'first-line tap must not jump the editor to the document bottom');
        assert(after.rootScroll<8,'first-line tap does not pan the whole document');
        await page.keyboard.insertText('追加');
        const expected=text.slice(0,after.selection.from)+'追加'+text.slice(after.selection.to);
        await waitBody(page,expected);assert.equal((await snapshot(page)).text,expected);
        await page.screenshot({path:path.join(output,engine+'-'+kind+'-'+mode+'.png')});
      },[fixture(text)]);
    }
  }

  await scenario('native-pan geometry replay keeps fixed layout top instead of shifted viewport top',async({page,posts,seed})=>{
    await open(page);const before=await snapshot(page);
    const initialLayoutTop=await page.locator('.memo-detail').evaluate(el=>parseFloat(el.style.top));
    assert(initialLayoutTop>=100,'fixture starts below the header');
    await page.evaluate(()=>{
      // Replay XCUITest observations only. This does not open an OS keyboard or
      // make WebKit itself perform its native visual viewport pan.
      const container=document.querySelector('#scroll-container'),originalRect=container.getBoundingClientRect.bind(container);
      container.getBoundingClientRect=()=>{const r=originalRect();return {x:r.x,y:40,left:r.left,right:r.right,top:40,bottom:40+r.height,width:r.width,height:r.height,toJSON(){return this;}};};
      Object.defineProperty(window,'scrollY',{configurable:true,get:()=>70});
      Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>420});
      Object.defineProperty(visualViewport,'offsetTop',{configurable:true,get:()=>70});
      visualViewport.dispatchEvent(new Event('resize'));
    });
    await delay(120);const after=await snapshot(page);
    const actualStyleTop=await page.locator('.memo-detail').evaluate(el=>parseFloat(el.style.top));
    observations.nativePanGeometryReplay={type:'geometry-stub replay of native XCUITest observations; not OS reproduction',replayedWindowScrollY:70,replayedContainerViewportTop:40,initialLayoutTop,actualStyleTop,before,after};
    assert.equal(actualStyleTop,initialLayoutTop,'fixed CSS top remains in the original layout coordinate system when native viewport pans');
    assert.deepEqual(await localMemo(page),seed[0],'viewport pan never changes stored memo or metadata');
    assert.equal(memoWrites(posts).length,0,'viewport pan never saves memo body');
  });
  async function gesture(page,{kind='tap',targetSelector='#d-text .cm-line',waitMs=0}={}) {
    return page.locator(targetSelector).first().evaluate(async (target,{kind,waitMs})=>{
      const rect=target.getBoundingClientRect(), x=rect.left+Math.min(38,rect.width-5), y=rect.top+15;
      const point=(identifier,dx=0,dy=0)=>({identifier,target,clientX:x+dx,clientY:y+dy,pageX:x+dx+scrollX,pageY:y+dy+scrollY,screenX:x+dx,screenY:y+dy});
      const emit=(type,touches,changed)=>{
        const event=new Event(type,{bubbles:true,cancelable:true});
        Object.defineProperties(event,{touches:{value:touches},targetTouches:{value:touches},changedTouches:{value:changed}});
        target.dispatchEvent(event);return event.defaultPrevented;
      };
      const touches=kind==='pinch'?[point(1),point(2,40,40)]:[point(1)];
      emit('touchstart',touches,touches);
      if(waitMs)await new Promise(resolve=>setTimeout(resolve,waitMs));
      if(kind==='drag')emit('touchmove',[point(1,0,60)],[point(1,0,60)]);
      if(kind==='scroll')document.querySelector('.cm-scroller').scrollTop+=64;
      if(kind==='cancel')emit('touchcancel',[],touches);
      const prevented=emit('touchend',[],kind==='drag'?[point(1,0,60)]:touches);
      return {prevented,x,y};
    },{kind,waitMs});
  }
  for(const [kind,text] of [['empty',''],['short','短い本文です。'],['long',Array.from({length:100},(_,i)=>'先頭 '+i+' 日本語🙂をタップして確認します。').join('\n')]]) {
    await scenario('initial-short-tap contract '+kind,async({page,posts})=>{
      await open(page);const before=await snapshot(page);const event=await gesture(page);await delay(80);const after=await snapshot(page);
      observations['contract '+kind]={syntheticTouch:true,initialNativeFocus:before.focus,event,before,after};
      assert.equal(event.prevented,true,'iPhone initial short tap suppresses native default focus pan');
      assert(after.focus,'short tap focuses the actual editor');
      assert(after.selection.from<Math.max(1,text.indexOf('\n')<0?text.length:text.indexOf('\n')),'caret remains on the tapped first line');
      assert.equal(after.text,text);assert.equal(memoWrites(posts).length,0);
      await page.keyboard.insertText('追記');
      await waitBody(page,text.slice(0,after.selection.from)+'追記'+text.slice(after.selection.to));
    },[fixture(text)],{width:390,height:844},{userAgent:IOS_USER_AGENT});
  }
  async function observeNativeFocusOptions(page){
    await page.evaluate(async()=>{
      const {EditorView}=await import('/vendor/codemirror/codemirror.js');
      window.memoFocusNativeCalls=[];
      const original=HTMLElement.prototype.focus;
      HTMLElement.prototype.focus=function(options){
        if(this.matches?.('#d-text .cm-content')){
          const selection=EditorView.findFromDOM(this).state.selection.main;
          window.memoFocusNativeCalls.push({argumentCount:arguments.length,preventScroll:options?.preventScroll===true,stateSelection:{from:selection.from,to:selection.to}});
        }
        return original.apply(this,arguments);
      };
    });
  }
  for(const route of ['first-tap','toolbar']){
    await scenario('explicit-native-prevent-scroll contract '+route,async({page})=>{
      await open(page);await observeNativeFocusOptions(page);
      if(route==='first-tap')await gesture(page);else await page.locator('#d-check').click();
      await delay(80);
      const calls=await page.evaluate(()=>window.memoFocusNativeCalls);
      observations['nativeFocusOptions '+route]={actualHTMLElementFocusArguments:calls,userAgent:IOS_USER_AGENT};
      assert(calls.some(call=>call.preventScroll===true),'Apple touch editor passes explicit preventScroll:true to native HTMLElement.focus');
      assert((await snapshot(page)).focus,'native focused editor remains the actual editing surface');
      if(route==='first-tap'){
        const after=await snapshot(page);
        assert(after.selection.from>0,'tap fixture chooses a caret after the document start');
        assert(calls.filter(call=>call.preventScroll).every(call=>call.stateSelection.from===after.selection.from&&call.stateSelection.to===after.selection.to),'tapped caret is selected before explicit native preventScroll focus');
        await page.keyboard.insertText('追加');
        await waitBody(page,'短い本文'.slice(0,after.selection.from)+'追加'+'短い本文'.slice(after.selection.to));
      }else await waitBody(page,'☐ 短い本文');
      await editor(page).press('Meta+z');await waitBody(page,'短い本文');
    },[fixture('短い本文')],{width:390,height:844},{userAgent:IOS_USER_AGENT});
  }
  await scenario('saved new memo checklist keeps typing and undo after its prefix',async({page,seed})=>{
    await page.locator('#btn-new-memo').click();await editor(page).waitFor();
    await page.locator('#d-check').click();const checked=await snapshot(page);
    assert.equal(checked.selection.from,2,'collapsed caret moves immediately after the newly inserted prefix');
    assert.equal(checked.selection.to,2);
    // Undo is scoped to the later append to a saved checkbox, rather than two
    // adjacent edits that CodeMirror may legitimately group within 500 ms.
    let entry;
    await until(async()=>{entry=await page.evaluate(()=>JSON.parse(localStorage.getItem('sth_v3_memo_all')||'[]').find(row=>row.id!=='memo-primary'));return entry?.body==='☐ ';},'new checkbox prefix is saved before the later append');
    await page.keyboard.insertText('予定');const typed=await snapshot(page);await waitBody(page,'☐ 予定',entry.id);
    observations.emptyNewChecklist={afterToolbar:checked,afterTyping:typed,savedBody:(await localMemo(page,entry.id)).body,undoPrecondition:'checkbox prefix persisted before append'};
    assert.equal(typed.text,'☐ 予定','typing follows the inserted checklist prefix');
    await editor(page).press('Meta+z');await waitBody(page,'☐ ',entry.id);
    assert.equal((await snapshot(page)).selection.from,2,'undo the later append leaves the saved checkbox and its following caret');
    assert.deepEqual(await localMemo(page),seed[0],'existing memo stays unchanged while editing a new one');
  });
  for(const kind of ['focused','longpress','drag','pinch','cancel','checkbox','scroll','range','composition']) {
    await scenario('native-gesture exception '+kind,async({page,posts})=>{
      await open(page);if(kind==='focused')await editor(page).focus();
      if(kind==='composition')await editor(page).evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'編集中'})));
      if(kind==='range')await page.evaluate(()=>{const range=document.createRange();range.selectNodeContents(document.querySelector('#d-text .cm-line'));const selection=getSelection();selection.removeAllRanges();selection.addRange(range);});
      const before=await snapshot(page);
      const event=await gesture(page,{kind:kind==='longpress'?'tap':kind,waitMs:kind==='longpress'?650:0,targetSelector:kind==='checkbox'?'.memo-editor-checkbox':'#d-text .cm-line'});
      await delay(30);
      assert.equal(event.prevented,false,'selection/scroll/long press/control gestures keep native default');
      assert.equal((await snapshot(page)).text,before.text);assert.equal(memoWrites(posts).length,0);
      if(kind==='composition')await editor(page).evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:''})));
    },kind==='scroll'?[fixture(Array.from({length:50},()=> 'スクロール中の本文').join(String.fromCharCode(10)))]:ordinary(),{width:390,height:844},{userAgent:IOS_USER_AGENT});
  }
  for(const [label,userAgent] of [['desktop','Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'],['android','Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36']]) {
    await scenario('native-gesture exception '+label,async({page})=>{
      await open(page);const event=await gesture(page);assert.equal(event.prevented,false,label+' tap retains native focus default');
    },ordinary(),{width:390,height:844},{userAgent});
  }
  fs.writeFileSync(path.join(output,engine+'-focus'+(process.env.MEMO_FOCUS_TEST?'-'+process.env.MEMO_FOCUS_TEST.replace(/[^a-z0-9]+/gi,'-').toLowerCase():'')+'-results.json'),JSON.stringify({engine,passed,failed,scenarios:outcomes,observations,actualOSKeyboard:false,syntheticViewportClearlySeparated:true},null,2)+'\n');
  await browser.close();server.close();console.log(`${passed} passed / ${failed} failed`);process.exitCode=failed?1:0;
})().catch(async error=>{console.error(error);await browser?.close();server.close();process.exitCode=1;});
