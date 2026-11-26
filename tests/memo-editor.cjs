// Isolated browser/editor QA. All API replies, memos and attachments are synthetic.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const playwright = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const root = process.env.APP_ROOT || path.resolve(__dirname, '..');
const engine = process.env.MEMO_ENGINE || 'chromium';
const output = process.env.MEMO_ARTIFACT_DIR || '/tmp/system-techo-memo-qa';
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
async function scenario(name, fn, seed = ordinary(), dimensions = { width: 390, height: 844 }) {
  if (process.env.MEMO_TEST && !name.includes(process.env.MEMO_TEST)) return;
  let context;
  try {
    context = await browser.newContext({ viewport: dimensions, isMobile: true, hasTouch: true, serviceWorkers: 'block', ...(engine === 'webkit' ? { userAgent: playwright.devices['iPhone 13'].userAgent } : {}) });
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
      if (localStorage.getItem('memo-qa:seeded')) return;
      localStorage.setItem('memo-qa:seeded', '1'); localStorage.setItem('sth_v3_cache_schema', '4'); localStorage.setItem('sth_v3_active_tab', 'memo');
      localStorage.setItem('sth_v3_memo_all', JSON.stringify(entries)); localStorage.setItem('memo-qa:unrelated', ' { "unchanged": [0,false] } ');
    }, seed);
    await page.goto(base); await page.locator('.memo-row').first().waitFor(); await delay(100);
    await fn({ page, opts, posts, gets, remote, seed });
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    assert.equal(await page.evaluate(() => localStorage.getItem('memo-qa:unrelated')), ' { "unchanged": [0,false] } ');
    passed++; outcomes.push({ name, result: 'passed' }); console.log('PASS', engine, name);
    await context.close(); context = null;
  } catch (error) {
    failed++; outcomes.push({ name, result: 'failed', error: error.message }); console.log('FAIL', engine, name, error.stack || error.message);
  } finally { await context?.close(); }
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
  browser = await playwright[engine].launch(engine === 'chromium' ? { headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : { headless: true });
  await scenario('rule toggle preserves existing body and does not save', async ({ page, posts, seed }) => {
    await open(page); const toggle = page.locator('#d-lines'); await toggle.waitFor();
    const before = await toggle.getAttribute('aria-pressed');
    await toggle.click(); assert.notEqual(await toggle.getAttribute('aria-pressed'), before);
    await toggle.click(); assert.equal(await toggle.getAttribute('aria-pressed'), before);
    await delay(850); await page.locator('#d-back').click();
    assert.deepEqual(await localMemo(page), seed[0]); assert.equal(memoWrites(posts).length, 0);
  });
  await scenario('no-op open/back preserves CRLF whitespace unknown text attachments and metadata exactly', async ({ page, posts, seed }) => {
    await open(page); assert.equal(await page.locator('.memo-att-file').textContent(), '📎 日本語.pdf');
    assert((await page.locator('.memo-detail-time').textContent()).includes('取込済'));
    await delay(850); await page.locator('#d-back').click();
    assert.deepEqual(await localMemo(page), seed[0]); assert.equal(memoWrites(posts).length, 0);
  }, [fixture('\r\n☑ 既存本文  \r\n[[future:そのまま|v1]]\r\n[[att:preserve-pdf|日本語.pdf|application/pdf]]\r\n  \t\r\n')]);
  await scenario('checked text and integrated ruling move together through long Japanese wrapped content', async ({ page, posts }) => {
    await open(page); const scroll = page.locator('#d-text .cm-scroller');
    const metric = async () => page.evaluate(() => {
      const content = document.querySelector('#d-text .cm-content'), scroll = document.querySelector('#d-text .cm-scroller');
      const done = document.querySelector('#d-text .memo-editor-done'); const contentStyle = getComputedStyle(content);
      return { scrollTop: scroll.scrollTop, doneTop: done.getBoundingClientRect().top, decoration: getComputedStyle(done).textDecorationLine, fontSize: contentStyle.fontSize, lineHeight: parseFloat(contentStyle.lineHeight), background: contentStyle.backgroundImage, lines: [...document.querySelectorAll('#d-text .cm-line')].map(line => ({ top: line.getBoundingClientRect().top - content.getBoundingClientRect().top - parseFloat(contentStyle.paddingTop), height: line.getBoundingClientRect().height })), hasOverlay: !!document.querySelector('#d-strike') };
    });
    await page.locator('#d-text .memo-editor-done').first().waitFor(); await delay(100);
    const before = await metric(); await scroll.evaluate(el => { el.scrollTop = 32; }); await delay(100); const after = await metric();
    observations.longMemo = { beforeScroll: before.scrollTop, afterScroll: after.scrollTop, strikeTopBefore: before.doneTop, strikeTopAfter: after.doneTop, fontSize: after.fontSize, lineHeight: after.lineHeight, sampledScrollPositions: [] };
    assert.equal(after.decoration.includes('line-through'), true); assert.equal(after.hasOverlay, false); assert.equal(after.lineHeight, 32);
    assert(after.background.includes('gradient'), 'ruling belongs to the scrolling content');
    assert(Math.abs((after.doneTop - before.doneTop) + after.scrollTop - before.scrollTop) < 1, 'strike text geometry follows actual scroll delta');
    for (const top of [900, 2800, 5000]) {
      await scroll.evaluate((el, top) => { el.scrollTop = top; }, top); await delay(120); const measured = await metric();
      observations.longMemo.sampledScrollPositions.push({ scrollTop: measured.scrollTop, visibleLogicalLines: measured.lines.length, maximumRowHeightError: Math.max(...measured.lines.map(line => Math.abs(line.height / 32 - Math.round(line.height / 32)))), maximumRulePhaseError: Math.max(...measured.lines.map(line => Math.abs(line.top / 32 - Math.round(line.top / 32)))) });
      for (const line of measured.lines) {
        assert(Math.abs(line.height / 32 - Math.round(line.height / 32)) < .025, 'every wrapped row keeps a whole 32px rhythm');
        assert(Math.abs(line.top / 32 - Math.round(line.top / 32)) < .025, 'ruling phase stays aligned near lower content');
      }
    }
    // Inspect rendered pixels as well as computed CSS: one WebKit engine painted
    // huge repeating backgrounds only at logical-line boundaries despite valid CSS.
    const ruleGeometry = await page.evaluate(() => {
      const content = document.querySelector('#d-text .cm-content').getBoundingClientRect();
      const scroll = document.querySelector('#d-text .cm-scroller').getBoundingClientRect();
      return { contentTop: content.top, top: scroll.top, bottom: scroll.bottom, x: scroll.left + 4 };
    });
    const ruledPng = await page.screenshot({ path: path.join(output, engine + '-long-scrolled.png') });
    await page.locator('#d-lines').click(); await delay(70); const plainPng = await page.screenshot();
    const renderedRules = await page.evaluate(async ({ on, off, geometry }) => {
      async function pixels(base64) {
        const img = new Image(); img.src = 'data:image/png;base64,' + base64;
        await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
        const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
        const context = canvas.getContext('2d'); context.drawImage(img, 0, 0);
        return { width: img.width, data: context.getImageData(0, 0, img.width, img.height).data };
      }
      const a = await pixels(on), b = await pixels(off), rows = [];
      const first = Math.ceil((geometry.top + 4 - geometry.contentTop) / 32);
      for (let row = first; geometry.contentTop + row * 32 < geometry.bottom - 4; row++) {
        const y = Math.round(geometry.contentTop + row * 32 - 1), x = Math.round(geometry.x);
        let difference = 0;
        for (let offset = -2; offset <= 2; offset++) {
          const index = ((y + offset) * a.width + x) * 4;
          difference = Math.max(difference, ...[0, 1, 2].map(channel => Math.abs(a.data[index + channel] - b.data[index + channel])));
        }
        rows.push({ y, difference });
      }
      return rows;
    }, { on: ruledPng.toString('base64'), off: plainPng.toString('base64'), geometry: ruleGeometry });
    observations.longMemo.renderedRuleRows = renderedRules;
    assert(renderedRules.length >= 8, 'sample includes at least eight lower visual rows');
    assert(renderedRules.every(row => row.difference >= 8), 'each visual row paints a ruling, including wrapped rows');
    await page.locator('#d-lines').click();

    assert.equal(memoWrites(posts).length, 0);
  }, [fixture(Array.from({ length: 80 }, (_, i) => `${i % 2 ? '☐' : '☑'} ${String(i + 1).padStart(2, '0')} 日本語🙂で長いメモを書きます。折り返した行でも罫線と取り消し線が文字と一緒に動くことを確認します。${i % 3 === 0 ? '長文をさらに足して複数行に折り返します。' : ''}`).join('\n'))]);
  await scenario('check toggles and undo preserve plain checkbox markers', async ({ page }) => {
    await open(page); await page.locator('.memo-editor-checkbox').first().click();
    await waitBody(page, '☑ 買い物\n☑ 済みの予定\n通常の本文\n');
    await editor(page).focus(); await editor(page).press('Meta+z'); await waitBody(page, '☐ 買い物\n☑ 済みの予定\n通常の本文\n');
    await replaceText(page, '☐ 次の予定'); await editor(page).press('End'); await editor(page).press('Enter'); await page.keyboard.insertText('追記');
    await waitBody(page, '☐ 次の予定\n☐ 追記');
  });
  await scenario('paste inserts literal multiline text rather than HTML', async ({ page }) => {
    await open(page); await editor(page).fill(''); await editor(page).focus();
    await editor(page).evaluate(el => { const data = new DataTransfer(); data.setData('text/plain', '貼り付け\n<strong>文字</strong>\n🙂'); data.setData('text/html', '<strong>文字</strong><img src=x onerror=alert(1)>'); el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); });
    await waitBody(page, '貼り付け\n<strong>文字</strong>\n🙂'); assert.equal(await page.locator('#d-text strong, #d-text img').count(), 0);
  });
  await scenario('composition defers autosave and composing Enter does not create checklist items', async ({ page, posts }) => {
    await open(page); await replaceText(page, '☐ 変換前'); await waitBody(page, '☐ 変換前');
    // Queue-first persistence becomes locally visible before its network attempt.
    // Settle that completed edit before counting writes caused by IME composition.
    await until(() => memoWrites(posts).some(post => post.entry.body === '☐ 変換前'), 'the completed pre-composition edit reaches its API attempt');
    const before = memoWrites(posts).length;
    observations.compositionSaves={beforeBodies:memoWrites(posts).map(post=>post.entry.body)};
    await editor(page).focus();
    await editor(page).dispatchEvent('compositionstart', { data: '' }); await page.keyboard.insertText('変換中');
    await editor(page).evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
    await delay(900);
    observations.compositionSaves.afterBodies=memoWrites(posts).map(post=>post.entry.body);
    assert.equal(memoWrites(posts).length, before, 'composition does not trigger partial memo saves');
    await editor(page).dispatchEvent('compositionend', { data: '変換中' });
    await until(async () => (await localMemo(page)).body.includes('変換中'), 'completed composition is eventually saved');
    const body = (await localMemo(page)).body; assert.equal(body.split('\n').length, 1, 'IME conversion Enter is not checklist continuation');
  });
  await scenario('offline edits retain attachments and outbox then replay', async ({ page, opts, posts }) => {
    await open(page); opts.offline = true; await editor(page).fill('更新した本文\n[[future:保全]]');
    await until(async () => (await page.evaluate(async () => (await import('/js/outbox.js')).listAll())).some(row => row.op.type === 'memo_upsert'), 'offline editor edit is durable');
    const local = await localMemo(page); assert.equal(local.body, '更新した本文\n[[future:保全]]\n[[att:preserve-pdf|日本語.pdf|application/pdf]]');
    opts.offline = false; await page.evaluate(async () => (await import('/js/sync.js')).flushAll());
    assert.equal((await page.evaluate(async () => (await import('/js/outbox.js')).listAll())).length, 0);
    assert.equal(memoWrites(posts).at(-1).entry.body, local.body);
  }, [fixture('既存本文\n[[att:preserve-pdf|日本語.pdf|application/pdf]]')]);
  await scenario('late save cannot roll a newer edit back', async ({ page, opts, remote, posts }) => {
    await open(page); opts.postDelay = body => body.entry?.body === '編集A' ? 1800 : 0;
    await replaceText(page, '編集A'); await until(() => memoWrites(posts).some(item => item.entry.body === '編集A'), 'first save starts');
    await replaceText(page, '編集B'); await delay(2400);
    assert.equal((await localMemo(page)).body, '編集B'); assert.equal(remote.get('memo-primary').body, '編集B');
  });
  await scenario('delayed attachment from memo A never writes into memo B', async ({ page, opts, posts }) => {
    await open(page); opts.uploadDelay = 1600;
    await page.locator('#d-file').setInputFiles({ name: '資料.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-synthetic') });
    await until(() => posts.some(item => item.type === 'memo_attach'), 'attachment upload starts');
    // Simulate a detail lifecycle switch while the upload's spinner is present.
    // Native pointer navigation is blocked by the spinner, but teardown/resume
    // callbacks still must remain bound to the original entry.
    await page.locator('#d-back').evaluate(el => el.click());
    await page.locator('.memo-row[data-id="memo-second"]').waitFor();
    await page.locator('.memo-row[data-id="memo-second"]').evaluate(el => el.click());
    await editor(page).waitFor(); await delay(2200);
    assert.equal((await localMemo(page, 'memo-second')).body, 'メモBの本文');
    assert((await localMemo(page)).body.includes('[[att:synthetic-pdf|資料.pdf|application/pdf]]'));
    assert.equal(await page.locator('.memo-att-file').count(), 0, 'attachment stays out of the other open editor');
  }, [fixture('メモAの本文'), { ...fixture('メモBの本文', 'memo-second'), title: '別のメモ' }]);
  await scenario('reserved attachment text cannot be lost by leaving a rejected save', async ({ page, posts, seed }) => {
    await open(page); const raw = '保持する本文\n[[att:new-id|new.pdf|application/pdf]]';
    await replaceText(page, raw); await delay(850);
    assert.equal(memoWrites(posts).length, 0, 'invalid serializer text never sends a replacement body');
    await page.locator('[data-tab="habit"]').click(); await delay(100);
    assert.equal(await editor(page).count(), 1, 'navigation is rejected while the editor cannot safely serialize its text');
    assert((await editor(page).innerText()).includes('[[att:new-id|new.pdf|application/pdf]]'));
    assert.deepEqual(await localMemo(page), seed[0], 'the saved body is untouched');
  });
  await scenario('new memo retries after temporary localStorage quota failure', async ({ page, posts }) => {
    await page.locator('#btn-new-memo').click(); await editor(page).waitFor();
    await page.evaluate(() => {
      window.memoQaSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'sth_v3_memo_all') throw new DOMException('synthetic quota', 'QuotaExceededError');
        return window.memoQaSetItem.call(this, key, value);
      };
    });
    await replaceText(page, '新規の本文A'); await delay(850);
    assert.equal(memoWrites(posts).length, 0, 'a failed local write is not treated as saved');
    await page.evaluate(() => { Storage.prototype.setItem = window.memoQaSetItem; delete window.memoQaSetItem; });
    await editor(page).press('End'); await page.keyboard.insertText('B');
    await until(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('sth_v3_memo_all')))).some(entry => entry.body === '新規の本文AB'), 'new memo must save after storage becomes writable again');
    await until(() => memoWrites(posts).some(item => item.entry.body === '新規の本文AB'), 'recovered new memo is sent through the queue');
  });
  await scenario('new memo is saved before its inbox request', async ({ page, posts }) => {
    await page.locator('#btn-new-memo').click(); await editor(page).waitFor();
    await replaceText(page, '新規の取込本文'); await page.locator('#d-take').click();
    await until(() => posts.some(item => item.type === 'memo_inbox_write'), 'inbox request completes');
    const saved = posts.findIndex(item => item.type === 'memo_upsert');
    const inbox = posts.findIndex(item => item.type === 'memo_inbox_write');
    assert(saved >= 0 && saved < inbox, 'new memo must reach the queue/server before inbox reads it');
    assert.equal(posts[saved].entry.body, '新規の取込本文');
  });
  await scenario('offline edit followed by delete never resurrects its body on replay', async ({ page, opts, remote }) => {
    await open(page); opts.offline = true; await replaceText(page, '送信待ちの編集');
    await until(async () => (await page.evaluate(async () => (await import('/js/outbox.js')).listAll())).some(row => row.op.type === 'memo_upsert'), 'pending edit persists');
    await page.locator('#d-delete').click(); await page.locator('#d-ok').click();
    await page.locator('#btn-new-memo').waitFor(); opts.offline = false;
    await page.evaluate(async () => (await import('/js/sync.js')).flushAll());
    assert.equal(remote.has('memo-primary'), false);
    const local = await localMemo(page); assert(!local || local.deleted, 'deleted memo is not recreated by an older edit');
  });
  await scenario('stale refresh cannot restore a memo deleted while its GET was in flight', async ({ page, opts }) => {
    await open(page); opts.getDelay = 900;
    await page.evaluate(async () => { window.memoQaRefresh = (await import('/js/memo.js')).pullAndRender(); });
    // Exercise overlapping lifecycle actions even though the visible refresh spinner
    // blocks ordinary pointer taps during this particular explicit refresh.
    await page.locator('#d-delete').evaluate(el => el.click()); await page.locator('#d-ok').evaluate(el => el.click());
    await page.evaluate(() => window.memoQaRefresh); await delay(100);
    const local = await localMemo(page); assert(!local || local.deleted, 'stale remote snapshot cannot resurrect a deletion');
  });
  await scenario('reopening memo A during upload retains its new text and the arriving attachment', async ({ page, opts, posts }) => {
    await open(page); opts.uploadDelay = 1700;
    await page.locator('#d-file').setInputFiles({ name: '資料.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-synthetic') });
    await until(() => posts.some(item => item.type === 'memo_attach'), 'attachment upload starts');
    await page.locator('#d-back').evaluate(el => el.click());
    await page.locator('.memo-row[data-id="memo-primary"]').waitFor();
    await page.locator('.memo-row[data-id="memo-primary"]').evaluate(el => el.click());
    await editor(page).waitFor(); await replaceText(page, '再開後の新しい本文'); await delay(2400);
    const local = await localMemo(page);
    assert(local.body.includes('再開後の新しい本文')); assert(local.body.includes('[[att:synthetic-pdf|資料.pdf|application/pdf]]'));
    assert.equal(await page.locator('.memo-att-file').count(), 1, 'current same-entry session receives the completed attachment');
  });
  await scenario('enqueue rejection cannot erase a locally saved edit across tab switch and reload', async ({ page, posts, remote }) => {
    await open(page);
    await page.evaluate(() => {
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function(value, ...rest) {
        if (this.name === 'outbox' && value?.op?.type === 'memo_upsert') throw new DOMException('synthetic enqueue rejection', 'UnknownError');
        return add.call(this, value, ...rest);
      };
    });
    await replaceText(page, 'キュー失敗後も守る本文'); await waitBody(page, 'キュー失敗後も守る本文'); await delay(150);
    assert.equal(memoWrites(posts).length, 0, 'failed enqueue has not reached the server');
    await page.locator('[data-tab="habit"]').click(); await delay(100); await page.reload();
    await page.locator('[data-tab="memo"]').click(); await page.locator('.memo-row[data-id="memo-primary"]').waitFor();
    await delay(1100);
    assert.equal((await localMemo(page)).body, 'キュー失敗後も守る本文', 'old GET cannot replace the locally saved unsent edit');
    await until(() => remote.get('memo-primary')?.body === 'キュー失敗後も守る本文', 'recovered queue resends the protected edit after reload');
  });
  await scenario('enqueue rejection recovers on the next edit in the same session', async ({ page, posts, remote }) => {
    await open(page);
    await page.evaluate(() => {
      const add = IDBObjectStore.prototype.add;
      window.memoQaRestoreEnqueue = () => { IDBObjectStore.prototype.add = add; };
      IDBObjectStore.prototype.add = function(value, ...rest) {
        if (this.name === 'outbox' && value?.op?.type === 'memo_upsert') throw new DOMException('synthetic one-session rejection', 'UnknownError');
        return add.call(this, value, ...rest);
      };
    });
    await replaceText(page, '一時キュー失敗の本文'); await waitBody(page, '一時キュー失敗の本文'); await delay(150);
    assert.equal(memoWrites(posts).length, 0);
    await page.evaluate(() => window.memoQaRestoreEnqueue());
    await replaceText(page, '同じ画面で再試行した最新本文'); await waitBody(page, '同じ画面で再試行した最新本文');
    await until(() => remote.get('memo-primary')?.body === '同じ画面で再試行した最新本文', 'same-session retry reaches the server');
    await until(async () => (await page.evaluate(async () => (await (await import('/js/sync.js')).pendingKeys()).size)) === 0, 'same-session pending queue releases its failed staging');
    await page.locator('#d-back').click(); await page.reload(); await page.locator('.memo-row[data-id="memo-primary"]').waitFor();
    assert.equal((await localMemo(page)).body, '同じ画面で再試行した最新本文');
  });
  await scenario('enqueue rejection cannot resurrect a local deletion on reload', async ({ page, remote }) => {
    await open(page);
    await page.evaluate(() => {
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function(value, ...rest) {
        if (this.name === 'outbox' && value?.op?.type === 'memo_delete') throw new DOMException('synthetic delete enqueue rejection', 'UnknownError');
        return add.call(this, value, ...rest);
      };
    });
    await page.locator('#d-delete').click(); await page.locator('#d-ok').click();
    await page.locator('#btn-new-memo').waitFor(); await delay(150); await page.reload();
    await page.locator('#btn-new-memo').waitFor(); await delay(1100);
    const local = await localMemo(page); assert(!local || local.deleted, 'stale server GET cannot restore a local deletion');
    await until(() => !remote.has('memo-primary'), 'recovered queue replays the protected deletion after reload');
  });
  await scenario('failed local deletion leaves the memo editable and does not send delete', async ({ page, posts }) => {
    await open(page);
    await page.evaluate(() => {
      const setItem = Storage.prototype.setItem;
      window.memoQaRestoreStorage = () => { Storage.prototype.setItem = setItem; };
      Storage.prototype.setItem = function(key, value) {
        if (this === localStorage && key === 'sth_v3_memo_all') throw new DOMException('synthetic delete cache failure', 'QuotaExceededError');
        return setItem.call(this, key, value);
      };
    });
    await page.locator('#d-delete').click(); await page.locator('#d-ok').click(); await delay(100);
    assert.equal(await editor(page).count(), 1, 'failed deletion retains the same editable memo');
    assert.equal(posts.filter(item => item.type === 'memo_delete').length, 0);
    await page.evaluate(() => window.memoQaRestoreStorage());
    await replaceText(page, '削除失敗後も編集を保存できる本文'); await waitBody(page, '削除失敗後も編集を保存できる本文');
    await page.locator('#d-back').click(); await page.locator('.memo-row[data-id="memo-primary"]').waitFor();
    assert.equal((await localMemo(page)).body, '削除失敗後も編集を保存できる本文');
    assert.equal(posts.filter(item => item.type === 'memo_delete').length, 0);
  });
  await scenario('tablet layout keeps editor within viewport', async ({ page }) => {
    await open(page); const bounds = await page.locator('#d-text').boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= 834); assert(bounds.y >= 0 && bounds.y + bounds.height <= 1112);
    await page.screenshot({ path: path.join(output, engine + '-tablet.png') });
  }, ordinary(), { width: 834, height: 1112 });
  fs.writeFileSync(path.join(output, engine + (process.env.MEMO_TEST ? '-' + process.env.MEMO_TEST.replace(/[^a-z0-9]+/gi, '-').toLowerCase() : '') + '-results.json'), JSON.stringify({ engine, passed, failed, scenarios: outcomes, observations, isolatedLocalOnly: true, actualIPhoneIME: 'not_verified', mobileSafariUserAgentEmulated: engine === 'webkit' }, null, 2) + '\n');
  await browser.close(); server.close(); console.log(`${passed} passed / ${failed} failed`); process.exitCode = failed ? 1 : 0;
})().catch(async error => { console.error(error); await browser?.close(); server.close(); process.exitCode = 1; });
