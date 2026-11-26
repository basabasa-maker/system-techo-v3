// Isolated backup-settings UI regression: synthetic responses, fresh context, no production or Health access.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const playwright = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const root = process.env.APP_ROOT || path.resolve(__dirname, '..');
const engine = process.env.BACKUP_ENGINE || 'chromium';
const output = process.env.BACKUP_ARTIFACT_DIR || '/tmp/system-techo-backup-settings';
fs.mkdirSync(output, { recursive: true });
const clone = value => JSON.parse(JSON.stringify(value));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const TODAY = '2027-01-01';
const PAIR = 'a'.repeat(43);
const items = [{ id: 'weight', label: '体重', type: 'decimal', icon: '⚖️', unit: 'kg' }];
const values = { weight: 61.5, steps: 1234, unknown: { zero: 0, keep: false } };
const health = { enabled: false, shortcutName: 'synthetic-health', pairKey: PAIR, verifiedKeys: ['weight'] };
const OFF = { enabled: false, hasBackups: false, lastSuccessAt: null, lastErrorCode: null };
const ON = { enabled: true, hasBackups: true, lastSuccessAt: '2026-11-25T18:05:00.000Z', lastErrorCode: null };
const cors = { 'Access-Control-Allow-Origin': '*' };
const outcomes = [];
let browser, base;
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) return response.writeHead(403).end();
  fs.readFile(file, (error, bytes) => {
    if (error) return response.writeHead(404).end();
    response.setHeader('Content-Type', ({ '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' })[path.extname(file)] || 'text/html; charset=utf-8');
    response.end(bytes);
  });
});
async function until(check, message, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(25); }
  assert.fail(message);
}
const status = page => page.locator('#settings-backup-status');
async function open(page) { await page.locator('#btn-settings').click(); await status(page).waitFor(); }
async function settled(page) {
  await until(async () => await page.locator('#settings-refresh-backup').isEnabled() && !(await status(page).textContent()).includes('確認しています'), 'backup status settles and retry remains usable');
  return status(page).textContent();
}
async function nextStatus(page, plans, value) { plans.push({ data: value }); await page.locator('#settings-refresh-backup').click(); return settled(page); }
async function storage(page) { return page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key !== 'sth_v3_theme'))); }
function deferred() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
async function scenario(name, work, prepare = null) {
  if (process.env.BACKUP_TEST && !name.includes(process.env.BACKUP_TEST)) return;
  let context, page;
  const gates = [];
  try {
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block', ...(engine === 'webkit' ? { userAgent: playwright.devices['iPhone 13'].userAgent } : {}) });
    page = await context.newPage(); page.setDefaultTimeout(4500);
    const errors = [], posts = [], requests = [], backupRequests = [], owners = [], plans = [];
    const options = { fallback: clone(OFF) };
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === base) return route.continue();
      if (url.hostname !== 'script.google.com') return route.abort();
      const payload = request.method() === 'POST' ? JSON.parse(request.postData()) : Object.fromEntries(url.searchParams);
      requests.push({ method: request.method(), url: url.href, payload });
      if (request.method() === 'POST') { posts.push(payload); return route.fulfill({ json: { ok: true, data: {} }, headers: cors }); }
      if (payload.type === 'backup_admin') {
        owners.push({ method: request.method(), url: url.href });
        return route.fulfill({ body: '<!doctype html><meta charset="utf-8"><title>合成の管理者画面</title><p>合成の管理者画面。Google認証や実操作は行いません。</p>', contentType: 'text/html; charset=utf-8', headers: cors });
      }
      if (payload.type === 'backup_status') {
        backupRequests.push({ method: request.method(), url: url.href });
        const plan = plans.shift() || { data: clone(options.fallback) };
        if (plan.gate) await plan.gate.promise;
        if (page.isClosed()) return;
        if (plan.abort) return route.abort();
        if (plan.raw !== undefined) return route.fulfill({ status: plan.httpStatus || 200, body: plan.raw, contentType: 'application/json', headers: cors });
        return route.fulfill({ status: plan.httpStatus || 200, json: plan.body || { ok: true, data: plan.data }, headers: cors });
      }
      let data = { entries: [], tasks: [], events: [], items: [], values: {}, days: {}, nodes: [], boards: [], board_items: [] };
      if (payload.type === 'habit_items') data = { items: clone(items) };
      if (payload.type === 'habit_day') data = { values: clone(values) };
      return route.fulfill({ json: { ok: true, data }, headers: cors });
    });
    await page.clock.setFixedTime(new Date('2027-01-01T12:00:00'));
    await page.addInitScript(({ items, values, health, today }) => {
      if (localStorage.getItem('backup-ui:seeded')) return;
      localStorage.setItem('backup-ui:seeded', '1'); localStorage.setItem('sth_v3_cache_schema', '4'); localStorage.setItem('sth_v3_active_tab', 'habit');
      localStorage.setItem('sth_v3_habit_items', JSON.stringify(items)); localStorage.setItem('sth_v3_habitday_' + today, JSON.stringify(values));
      localStorage.setItem('sth_v3_health_settings', JSON.stringify(health));
      localStorage.setItem('sth_v3_memo_all', JSON.stringify([{ id: 'keep-memo', body: '保持する本文\r\n[[att:keep|写真.jpg|image/jpeg]]', deleted: 0 }]));
      localStorage.setItem('backup-ui:unrelated', ' { "unknown": [0,false,"保持"] } ');
    }, { items, values, health, today: TODAY });
    await page.goto(base); await page.locator('[data-id="weight"] input').waitFor();
    await until(() => Promise.resolve(requests.some(row => row.payload.type === 'habit_day')), 'initial synthetic day read completes'); await delay(80);
    if (prepare) await prepare(page);
    const before = await storage(page);
    await work({ page, context, plans, options, requests, backupRequests, owners, posts, gates });
    assert.deepEqual(await storage(page), before, 'backup settings leave records, Health keys and unrelated local values unchanged');
    assert.equal(posts.length, 0, 'backup status/settings perform no POST or record mutation');
    assert.deepEqual(errors, [], 'no uncaught browser error');
    assert(backupRequests.every(row => row.method === 'GET' && [...new URL(row.url).searchParams.keys()].join(',') === 'type'), 'public status is a GET with only its type');
    outcomes.push({ name, result: 'passed' }); console.log('PASS', engine, name);
  } catch (error) {
    outcomes.push({ name, result: 'failed', error: error.message }); console.log('FAIL', engine, name, error.stack || error.message);
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, engine + '-failure-' + outcomes.length + '.png') }).catch(() => {});
  } finally { for (const gate of gates) gate.release(); await context?.close(); }
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
  browser = await playwright[engine].launch(engine === 'chromium' ? { headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : { headless: true });
  await scenario('loading and enabled stopped empty history error states remain read-only', async ({ page, plans, gates, backupRequests }) => {
    const gate = deferred(); gates.push(gate); plans.push({ gate, data: { ...ON, privateCopyId: 'PRIVATE_COPY_ID', ownerEmail: 'private-owner@example.invalid' } });
    await open(page); await until(() => Promise.resolve(backupRequests.length === 1), 'one status read starts');
    assert((await status(page).textContent()).includes('確認しています')); assert.equal(await page.locator('#settings-refresh-backup').isDisabled(), true);
    assert.equal(await page.locator('#settings-close').isEnabled(), true); assert.equal(await status(page).getAttribute('role'), 'status');
    gate.release(); let text = await settled(page); assert(text.includes('有効')); assert(text.includes('毎日・日本時間3時台')); assert(text.includes('2026/11/26 03:05')); assert(!text.includes('PRIVATE_COPY_ID') && !text.includes('private-owner'));
    text = await nextStatus(page, plans, OFF); assert(text.includes('停止中')); assert(text.includes('まだ作成されていません'));
    text = await nextStatus(page, plans, { ...OFF, hasBackups: true }); assert(text.includes('コピーがあります')); assert(text.includes('日時は確認できません'));
    text = await nextStatus(page, plans, { ...ON, lastErrorCode: '<img src=x onerror=alert(1)>PRIVATE_ERROR' }); assert(text.includes('前回の処理は完了していません')); assert.equal(await status(page).getAttribute('class').then(value => value.includes('settings-error')), true); assert(!text.includes('PRIVATE_ERROR')); assert.equal(await status(page).locator('img').count(), 0);
    text = await nextStatus(page, plans, ON); assert(text.includes('有効')); assert(!(await status(page).getAttribute('class')).includes('settings-error'));
    await page.locator('#settings-close').click();
  });
  await scenario('failed malformed and offline reads show an error and recover with retry', async ({ page, plans }) => {
    plans.push({ abort: true }); await open(page); assert((await settled(page)).includes('通信を確認して再確認'));
    for (const plan of [{ httpStatus: 503, data: OFF }, { raw: '{ invalid json' }, { body: { ok: false, error: 'PRIVATE_DETAIL' } }, { data: { ...ON, enabled: 'true' } }]) {
      plans.push(plan); await page.locator('#settings-refresh-backup').click(); const text = await settled(page); assert(text.includes('確認できませんでした')); assert(!text.includes('PRIVATE_DETAIL')); assert((await status(page).getAttribute('class')).includes('settings-error'));
    }
    assert((await nextStatus(page, plans, OFF)).includes('停止中')); assert(!(await status(page).getAttribute('class')).includes('settings-error'));
  });
  await scenario('return refresh respects hidden state and avoids overlap', async ({ page, plans, backupRequests, gates }) => {
    await open(page); await settled(page); const initial = backupRequests.length;
    await page.evaluate(() => { window.backupVisibility = 'hidden'; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.backupVisibility }); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
    await delay(60); assert.equal(backupRequests.length, initial, 'hidden page does not refresh');
    plans.push({ data: ON }); await page.evaluate(() => { window.backupVisibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
    assert((await settled(page)).includes('有効')); assert.equal(backupRequests.length, initial + 1);
    const gate = deferred(); gates.push(gate); plans.push({ gate, data: OFF }); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await until(() => Promise.resolve(backupRequests.length === initial + 2), 'visible focus triggers a read');
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); }); await delay(60); assert.equal(backupRequests.length, initial + 2, 'in-flight read is not duplicated');
    gate.release(); assert((await settled(page)).includes('停止中'));
  });
  await scenario('owner button opens only backup_admin and never an anonymous control action', async ({ page, context, owners }) => {
    await open(page); await settled(page);
    const popupPromise = context.waitForEvent('page'); await page.locator('#settings-open-backup').click(); const popup = await popupPromise; await popup.waitForLoadState('domcontentloaded');
    const url = new URL(popup.url()); assert.equal(url.hostname, 'script.google.com'); assert.deepEqual([...url.searchParams], [['type', 'backup_admin']]);
    assert.equal(owners.length, 1); assert.equal(owners[0].method, 'GET'); assert.equal(await popup.title(), '合成の管理者画面'); assert.equal(await popup.evaluate(() => window.opener), null, 'owner page has no opener reference');
    await popup.close(); await page.locator('#settings-close').click();
  });
  await scenario('late successful response after close cannot replace a newer dialog status', async ({ page, plans, backupRequests, gates }) => {
    const gate = deferred(); gates.push(gate); plans.push({ gate, data: ON }); await open(page); await until(() => Promise.resolve(backupRequests.length === 1), 'old read starts');
    await page.locator('#settings-close').click(); plans.push({ data: OFF }); await open(page); assert((await settled(page)).includes('停止中'));
    gate.release(); await delay(80); assert((await status(page).textContent()).includes('停止中')); assert.equal(await page.locator('.app-settings-modal').count(), 1);
  });
  await scenario('late error after close stays detached and return listeners are removed', async ({ page, plans, backupRequests, gates }) => {
    const gate = deferred(); gates.push(gate); plans.push({ gate, body: { ok: false } }); await open(page); await until(() => Promise.resolve(backupRequests.length === 1), 'old read starts');
    await page.locator('#settings-close').click(); gate.release(); await delay(80); assert.equal(await page.locator('.app-settings-modal').count(), 0);
    const count = backupRequests.length; await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); }); await delay(60); assert.equal(backupRequests.length, count, 'closed dialog removed return listeners');
    plans.push({ data: ON }); await open(page); assert((await settled(page)).includes('有効')); assert(!(await status(page).getAttribute('class')).includes('settings-error'));
  });
  await scenario('pending Health request and prior import bytes survive read-only checks', async ({ page, plans }) => {
    await open(page); await settled(page); await nextStatus(page, plans, ON);
    await page.locator('#settings-close').click(); await open(page); await settled(page); await page.locator('#settings-close').click();
  }, async page => {
    await page.evaluate(({ today }) => {
      localStorage.setItem('sth_v3_health_pending', JSON.stringify({ request_id: 'b'.repeat(43), date: today, issued_at: Date.now(), baseline: { weight: 61.5 }, editedKeys: [], future: { keep: false } }));
      localStorage.setItem('sth_v3_health_last_sync', ' { "date":"2026-12-31", "keys":["weight"], "future":false } ');
    }, { today: TODAY });
  });
  await scenario('narrow mobile layouts in dark and light themes keep controls visible', async ({ page, plans }) => {
    plans.push({ data: { ...ON, lastErrorCode: 'COPY_FAILED' } }); await open(page); await settled(page);
    for (const width of [320, 390]) for (const theme of ['navy', 'cream']) {
      await page.setViewportSize({ width, height: 844 }); await page.locator('[data-theme-id="' + theme + '"]').click();
      await page.locator('#settings-backup-title').scrollIntoViewIfNeeded();
      const geometry = await page.evaluate(() => {
        const selector = ['.app-settings-modal [role="dialog"]', '#settings-backup-status', '#settings-open-backup', '#settings-refresh-backup', '#settings-close'];
        return { overflow: document.documentElement.scrollWidth > innerWidth, elements: selector.map(selector => { const el = document.querySelector(selector), r = el.getBoundingClientRect(); return { selector, x: r.x, right: r.right, width: r.width, height: r.height }; }) };
      });
      assert.equal(geometry.overflow, false); for (const el of geometry.elements) { assert(el.x >= -1 && el.right <= width + 1, el.selector + ' fits mobile width'); if (el.selector.includes('backup') && !el.selector.includes('status')) assert(el.height >= 40, 'backup control remains a usable touch target'); }
      assert.equal(await page.locator('#settings-close').isVisible(), true); await page.screenshot({ path: path.join(output, engine + '-backup-' + width + '-' + theme + '.png') });
    }
    await page.locator('#settings-close').click();
  });
  await browser.close(); await new Promise(resolve => server.close(resolve));
  const failed = outcomes.filter(row => row.result === 'failed').length;
  fs.writeFileSync(path.join(output, engine + '-results.json'), JSON.stringify({ engine, passed: outcomes.length - failed, failed, outcomes }, null, 2));
  console.log('Backup settings UI:', outcomes.length - failed, 'passed,', failed, 'failed'); process.exitCode = failed ? 1 : 0;
})().catch(async error => { console.error(error); await browser?.close(); server.close(); process.exitCode = 1; });
