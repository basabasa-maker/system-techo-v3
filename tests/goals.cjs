// Independent localhost origin, temporary browser contexts, and synthetic GAS only.
// Never connects to production GAS, Sheets, normal browser profiles, or external images.
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const root = path.resolve(process.env.APP_ROOT || path.join(__dirname, '..'));
const CACHE = 'sth_v3_goals_cache';
const clone = value => JSON.parse(JSON.stringify(value));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const headers = { 'Access-Control-Allow-Origin': '*' };
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=';
const now = '2026-11-24 12:00';
const seed = {
  nodes: [
    { id: 'purpose-life', kind: 'purpose', parent_id: '', title: '心地よく、豊かに暮らす', description: '大切な人と、自分の時間を大切にする', sort_order: 10, created_at: now, updated_at: now, deleted: 0, future_field: { keep: true } },
    { id: 'purpose-learning', kind: 'purpose', parent_id: '', title: '学びを楽しむ', description: '新しい視点を増やす', sort_order: 20, created_at: now, updated_at: now, deleted: 0 },
    { id: 'goal-travel', kind: 'goal', parent_id: 'purpose-life', title: '年に一度、ゆっくり旅をする', description: '景色を楽しむ', cover_item_id: '', sort_order: 10, created_at: now, updated_at: now, deleted: 0 },
    { id: 'goal-work', kind: 'goal', parent_id: 'purpose-learning', title: '好きな仕事を育てる', description: '', cover_item_id: '', sort_order: 20, created_at: now, updated_at: now, deleted: 0 },
    { id: 'means-save', kind: 'means', parent_id: 'goal-travel', title: '毎月、旅の資金を積み立てる', description: '', sort_order: 10, created_at: now, updated_at: now, deleted: 0 },
    { id: 'means-places', kind: 'means', parent_id: 'goal-travel', title: '行きたい場所を集める', description: '', sort_order: 20, created_at: now, updated_at: now, deleted: 0 },
  ],
  boards: [{ id: 'vision-main', title: 'わたしの未来', background: 'cork', width: 1200, height: 1600, updated_at: now, deleted: 0 }],
  items: [{ id: 'photo-travel', board_id: 'vision-main', attachment_id: 'attachment-travel', name: '旅のイメージ.png', mime: 'image/png', x: 60, y: 70, width: 600, height: 400, rotation: -5, z_index: 1, caption: '大切な人と過ごす時間', goal_id: 'goal-travel', updated_at: now, deleted: 0, future_item: { keep: 0 } }],
};
const legacy = {
  sth_v3_cache_schema: '4',
  sth_v3_tasks_cache: ' [ { "id":"old-task", "title":"保持する既存タスク", "due_date":"2026-12-01", "created_at":"2026-11-01 09:00", "updated_at":"2026-11-02 09:00", "deleted":0, "future_field":"keep" } ] ',
  sth_v3_memo_all: ' [ { "id":"old-memo", "entry_type":"note", "body":"保持する既存メモ", "claude_taken":"2026-11-20 09:00", "pinned":1 } ] ',
  sth_v3_memo_notes: ' [ { "id":"old-note", "body":"保持する控え" } ] ',
  'sth_v3_habitday_2026-11-01': ' { "weight":60, "steps":0, "future":false } ',
  'sth_v3_mealday_2026-11-01': ' { "朝":{"text":"保持する朝食","time":"08:00"} } ',
  sth_v3_task_sort: 'manual',
  'test:unknown-existing-setting': ' { "keep":[0,false,"文字"] } ',
};
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, bytes) => {
    if (error) { res.writeHead(404).end(); return; }
    const ext = path.extname(file);
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' })[ext] || 'text/html');
    res.end(bytes);
  });
});
let browser;
let failures = 0;
let completed = 0;

async function until(check, message, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(40); }
  assert.fail(message);
}
async function readCache(page) { return page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{"nodes":[],"boards":[],"items":[]}'), CACHE); }
async function rows(page) { return page.evaluate(async () => (await import('/js/outbox.js')).listAll()); }
async function chooseView(page, view) { await page.locator(`[data-goals-view="${view}"]`).click(); }
async function openPhotoEditor(page, photo, layout = false) {
  await photo.click();
  await page.locator(layout ? '#photo-menu-layout' : '#photo-menu-edit').click();
  await page.locator('#image-caption').waitFor();
}
async function legacyValues(page) { return page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), Object.keys(legacy)); }
async function screenshot(page, name) {
  if (!process.env.GOALS_SCREENSHOT_DIR) return;
  fs.mkdirSync(process.env.GOALS_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.GOALS_SCREENSHOT_DIR, name + '.png'), fullPage: true });
}

async function scenario(name, test, initial = seed) {
  if (process.env.GOALS_TEST && !name.includes(process.env.GOALS_TEST)) return;
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const remote = clone(initial);
    const opts = { offline: false, getDelay: 0, postDelay: 0, failAttach: false };
    const posts = [], gets = [], media = new Map([['attachment-travel', { name: '旅のイメージ.png', mime: 'image/png', data: pixel }]]);
    let nextMedia = 0;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === base) return route.continue();
      if (url.hostname !== 'script.google.com') return route.abort();
      const data = request.method() === 'POST' ? JSON.parse(request.postData()) : Object.fromEntries(url.searchParams);
      if (request.method() === 'POST') posts.push(clone(data)); else gets.push(clone(data));
      if (opts.offline) return route.abort();
      if (request.method() === 'POST') {
        await delay(opts.postDelay);
        if (data.type === 'memo_attach') {
          if (opts.failAttach) return route.fulfill({ json: { ok: false, error: 'synthetic attachment failure' }, headers });
          const id = 'uploaded-' + (++nextMedia);
          media.set(id, { name: data.name, mime: data.mime, data: data.data });
          return route.fulfill({ json: { ok: true, data: { id, name: data.name, mime: data.mime } }, headers });
        }
        const types = { goal_node_upsert: ['nodes', 'node'], goal_board_upsert: ['boards', 'board'], goal_item_upsert: ['items', 'item'] };
        const target = types[data.type];
        if (target) {
          const entity = data[target[1]];
          assert(entity && entity.id, 'synthetic API receives expected named entity');
          const index = remote[target[0]].findIndex(row => row.id === entity.id);
          if (index < 0) remote[target[0]].push(clone(entity)); else remote[target[0]][index] = { ...remote[target[0]][index], ...clone(entity) };
          return route.fulfill({ json: { ok: true, data: clone(entity) }, headers });
        }
        return route.fulfill({ json: { ok: true, data: {} }, headers });
      }
      let response;
      if (data.type === 'goals') response = clone(remote);
      else if (data.type === 'memo_attach_get') response = media.has(data.id) ? { id: data.id, ...media.get(data.id) } : null;
      else response = { tasks: [], entries: [], events: [], items: [], values: {}, days: {} };
      await delay(opts.getDelay);
      return route.fulfill({ json: response === null ? { ok: false, error: 'synthetic missing attachment' } : { ok: true, data: response }, headers });
    });
    await page.addInitScript(({ initial, legacy, key }) => {
      if (!localStorage.getItem('test:goals-fixture-initialized')) {
        for (const [name, value] of Object.entries(legacy)) localStorage.setItem(name, value);
        localStorage.setItem(key, JSON.stringify(initial));
        localStorage.setItem('test:goals-fixture-initialized', '1');
      }
      localStorage.setItem('sth_v3_active_tab', 'goals');
    }, { initial, legacy, key: CACHE });
    await page.goto(base);
    await page.locator('[data-tab="goals"]').click();
    await page.locator('.goals-tab').waitFor();
    await test({ page, opts, remote, posts, gets, media });
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    completed++;
    console.log('PASS', name);
  } catch (error) {
    failures++;
    console.log('FAIL', name, error.stack || error.message);
  } finally { await context?.close(); }
}

let base;
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });

  await scenario('separate purpose and goal lists preserve their hierarchy', async ({ page }) => {
    await chooseView(page, 'purposes');
    assert.equal(await page.locator('.purpose-card').count(), 2);
    assert((await page.locator('.goals-tab').innerText()).includes('心地よく、豊かに暮らす'));
    assert.equal(await page.locator('.goal-card').count(), 0);
    await screenshot(page, 'purposes');
    await chooseView(page, 'goals');
    assert.equal(await page.locator('.goal-card').count(), 2);
    const card = page.locator('.goal-card[data-goal-id="goal-travel"]');
    const text = await card.innerText();
    assert(text.includes('心地よく、豊かに暮らす'), 'goal identifies its purpose');
    assert(text.includes('毎月、旅の資金を積み立てる'), 'goal exposes its means');
    assert(text.includes('行きたい場所を集める'));
    await screenshot(page, 'goal-cards');
    assert.deepEqual(await legacyValues(page), legacy);
  });

  await scenario('shared plus menu opens purpose and goal editors and the board photo picker', async ({ page }) => {
    for (const view of ['purposes', 'goals']) {
      await chooseView(page, view);
      const menu = page.locator('.goals-add-menu');
      assert.equal(await menu.isVisible(), false, 'actions stay hidden until plus is tapped');
      await page.locator('#goals-add').click();
      assert(await menu.isVisible());
      assert.equal(await page.locator('#goals-add').getAttribute('aria-expanded'), 'true');
      assert(await page.locator('#goals-add-purpose').isVisible());
      assert(await page.locator('#goals-add-goal').isVisible());
      await page.locator(view === 'purposes' ? '#goals-add-purpose' : '#goals-add-goal').click();
      await page.locator('.goals-modal #g-title').waitFor();
      assert.equal(await menu.isVisible(), false, 'choosing an action closes the menu');
      await page.locator('.goals-modal [data-close]').click();
      await page.locator('.goals-modal').waitFor({ state: 'detached' });
      await page.locator('#goals-add').click();
      await page.keyboard.press('Escape');
      assert.equal(await menu.isVisible(), false, 'Escape closes the action menu');
    }
    await chooseView(page, 'board');
    await page.locator('#goals-add').click();
    assert(await page.locator('#goals-add-photo').isVisible());
    await screenshot(page, 'add-menu');
    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('#goals-add-photo').click();
    await (await chooserPromise).setFiles([]);
    assert.deepEqual(await legacyValues(page), legacy);
  });

  await scenario('create a purpose, goal, and multiple means through the editors', async ({ page, remote }) => {
    await chooseView(page, 'purposes');
    await page.locator('#goals-add').click();
    await page.locator('#goals-add-purpose').click();
    await page.locator('#g-title').fill('新しい目的');
    await page.locator('#g-description').fill('自分の価値観を言葉にする');
    await page.locator('#g-save').click();
    await page.locator('.goals-modal').waitFor({ state: 'detached' });
    await until(async () => (await readCache(page)).nodes.some(node => node.kind === 'purpose' && node.title === '新しい目的'), 'purpose is saved');
    const purpose = (await readCache(page)).nodes.find(node => node.kind === 'purpose');
    await chooseView(page, 'goals');
    await page.locator('#goals-add').click();
    await page.locator('#goals-add-goal').click();
    await page.locator('#g-title').fill('新しい目標');
    await page.locator('#g-parent').selectOption(purpose.id);
    await page.locator('#g-description').fill('目的に近づく具体的な達成状態');
    if (await page.locator('.goal-means-input').count() === 0) await page.locator('#g-add-means').click();
    await page.locator('.goal-means-input').first().fill('毎朝10分取り組む');
    await page.locator('#g-add-means').click();
    await page.locator('.goal-means-input').nth(1).fill('週に一度振り返る');
    await page.locator('#g-save').click();
    await page.locator('.goals-modal').waitFor({ state: 'detached' });
    await until(async () => (await readCache(page)).nodes.filter(node => node.kind === 'means' && !node.deleted).length === 2, 'both means are saved');
    const saved = await readCache(page), goal = saved.nodes.find(node => node.kind === 'goal');
    assert.equal(goal.parent_id, purpose.id);
    assert.deepEqual(saved.nodes.filter(node => node.kind === 'means').map(node => [node.parent_id, node.title]), [[goal.id, '毎朝10分取り組む'], [goal.id, '週に一度振り返る']]);
    await page.evaluate(async () => (await import('/js/sync.js')).flushAll());
    assert.equal(remote.nodes.filter(node => !node.deleted).length, 4);
    assert.deepEqual(await legacyValues(page), legacy);
  }, { nodes: [], boards: [], items: [] });

  await scenario('board captions, rotation and goal cover reference one shared attachment', async ({ page, posts }) => {
    await chooseView(page, 'goals');
    const card = page.locator('.goal-card[data-goal-id="goal-travel"]');
    await until(async () => card.locator('img').evaluateAll(images => images.some(image => image.naturalWidth > 0)), 'goal cover loads');
    const coverSource = await card.locator('img').first().getAttribute('src');
    await card.getByRole('button', { name: 'ボードで見る', exact: true }).click();
    const photo = page.locator('.board-photo[data-item-id="photo-travel"]');
    await photo.waitFor();
    await until(async () => photo.locator('.board-image').evaluate(image => image.naturalWidth > 0), 'board photo loads');
    assert.equal(await photo.locator('.board-image').getAttribute('src'), coverSource, 'card and board use the same loaded attachment');
    await screenshot(page, 'vision-board');
    await openPhotoEditor(page, photo);
    assert.equal(await page.locator('.image-placement-settings').evaluate(element => element.open), false, 'placement controls start collapsed');
    assert.equal(await page.locator('#image-rotation').isVisible(), false);
    await page.locator('#image-caption').fill('説明だけを追記する');
    await page.locator('#image-save').click();
    await page.locator('.goals-modal').waitFor({ state: 'detached' });
    const captionOnly = (await readCache(page)).items.find(item => item.id === 'photo-travel');
    assert.equal(captionOnly.caption, '説明だけを追記する');
    assert.equal(captionOnly.rotation, -5, 'caption-only editing keeps collapsed placement settings');
    assert.equal(captionOnly.width, 600);
    assert.equal(captionOnly.attachment_id, 'attachment-travel');
    await openPhotoEditor(page, photo);
    await page.locator('#image-caption').fill('この未来を大切にしたい');
    await page.locator('#image-goal').selectOption('goal-travel');
    await page.locator('.image-placement-settings summary').click();
    const angle = page.locator('#image-rotation');
    assert(await angle.isVisible(), 'placement settings can be expanded for rotation and cover selection');
    let rotation = 12;
    if (await angle.getAttribute('type') === 'range') { await angle.press('End'); rotation = Number(await angle.getAttribute('max')); }
    else await angle.fill(String(rotation));
    await page.locator('#image-cover').check();
    await page.locator('#image-save').click();
    await page.locator('.goals-modal').waitFor({ state: 'detached' });
    await until(async () => (await readCache(page)).items.find(item => item.id === 'photo-travel')?.caption === 'この未来を大切にしたい', 'caption saves');
    const saved = await readCache(page), item = saved.items.find(row => row.id === 'photo-travel');
    assert.equal(item.rotation, rotation);
    assert.equal(item.attachment_id, 'attachment-travel');
    assert.equal(item.future_item.keep, 0);
    assert.equal(saved.nodes.find(node => node.id === 'goal-travel').cover_item_id, item.id);
    await chooseView(page, 'goals');
    const nextCover = page.locator('.goal-card[data-goal-id="goal-travel"] img').first();
    await until(async () => !!await nextCover.getAttribute('src'), 'cover returns after board save');
    assert.equal(await nextCover.getAttribute('src'), coverSource);
    assert.equal(posts.filter(post => post.type === 'memo_attach').length, 0, 'linking and rotating never reuploads image data');
    assert.deepEqual(await legacyValues(page), legacy);
  });

  await scenario('offline edits and unknown outbox entries survive reload without clearing old data', async ({ page, opts, remote }) => {
    opts.offline = true;
    const unknown = { type: 'unknown_future_operation', payload: { id: 'keep-this', value: { flag: false, n: 0 } } };
    await page.evaluate(async unknown => (await import('/js/outbox.js')).enqueue(unknown), unknown);
    const before = (await rows(page)).find(row => row.op.type === unknown.type);
    await chooseView(page, 'goals');
    await page.locator('.goal-card[data-goal-id="goal-travel"]').getByRole('button', { name: '手段を編集', exact: true }).click();
    await page.locator('#g-title').fill('オフラインで追記した目標');
    await page.locator('#g-save').click();
    await page.locator('.goals-modal').waitFor({ state: 'detached' });
    await until(async () => (await rows(page)).some(row => row.op.type === 'goal_node_upsert' && row.op.payload.id === 'goal-travel'), 'goal is durably queued');
    await page.reload();
    await page.locator('.goals-tab').waitFor();
    await chooseView(page, 'goals');
    assert((await page.locator('.goal-card[data-goal-id="goal-travel"]').innerText()).includes('オフラインで追記した目標'));
    assert.equal((await readCache(page)).nodes.find(node => node.id === 'purpose-life').future_field.keep, true);
    assert.deepEqual((await rows(page)).find(row => row.op.type === unknown.type), before);
    assert.deepEqual(await legacyValues(page), legacy);
    opts.offline = false;
    await page.evaluate(async () => (await import('/js/sync.js')).flushAll());
    assert.equal(remote.nodes.find(node => node.id === 'goal-travel').title, 'オフラインで追記した目標');
    assert.deepEqual(await rows(page), [before]);
  });

  await scenario('late refresh cannot undo a goal edit that has already been sent', async ({ page, opts }) => {
    opts.getDelay = 900;
    await page.locator('#btn-refresh').click();
    await delay(70);
    await chooseView(page, 'goals');
    await page.locator('.goal-card[data-goal-id="goal-travel"]').getByRole('button', { name: '手段を編集', exact: true }).click();
    await page.locator('#g-title').fill('取得開始後に編集した目標');
    await page.locator('#g-save').click();
    await page.locator('.goals-modal').waitFor({ state: 'detached' });
    await page.evaluate(async () => (await import('/js/sync.js')).flushAll());
    await delay(1050);
    assert.equal((await readCache(page)).nodes.find(node => node.id === 'goal-travel').title, '取得開始後に編集した目標');
    assert((await page.locator('.goal-card[data-goal-id="goal-travel"]').innerText()).includes('取得開始後に編集した目標'));
  });

  await scenario('tab strip scrolls and long-press reorder persists without switching active tab', async ({ page }) => {
    const strip = page.locator('#tab-bar');
    const dimensions = await strip.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
    assert(dimensions.content > dimensions.width, 'six readable tabs overflow horizontally');
    await strip.evaluate(element => { element.scrollLeft = 0; });
    const habit = page.locator('#tab-bar [data-tab="habit"]');
    await habit.scrollIntoViewIfNeeded();
    const box = await habit.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await delay(520);
    await page.mouse.move(5, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    await until(async () => page.evaluate(() => JSON.parse(localStorage.getItem('sth_v3_tab_order') || '[]')[0] === 'habit'), 'dragged tab order is saved');
    assert.equal(await page.locator('#tab-bar .tab-btn.active').getAttribute('data-tab'), 'goals', 'drag does not select the held tab');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('sth_v3_tab_order')));
    await page.reload();
    await page.locator('.goals-tab').waitFor();
    assert.deepEqual(await page.locator('#tab-bar .tab-btn').evaluateAll(buttons => buttons.map(button => button.dataset.tab)), saved);
    assert.equal(await page.locator('#tab-bar .tab-btn').first().getAttribute('data-tab'), 'habit');
  });

  await scenario('long-press photo movement saves once and cancellation keeps the saved position', async ({ page, opts }) => {
    opts.offline = true;
    await chooseView(page, 'board');
    const photo = page.locator('.board-photo[data-item-id="photo-travel"]');
    await photo.waitFor();
    assert.equal(await page.locator('#board-edit').count(), 0, 'photo movement needs no edit-mode switch');
    const initial = (await readCache(page)).items.find(item => item.id === 'photo-travel');
    const box = await photo.boundingBox();
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await delay(520);
    await page.mouse.move(from.x + 30, from.y + 45, { steps: 8 });
    const during = (await readCache(page)).items.find(item => item.id === initial.id);
    assert.deepEqual([during.x, during.y], [initial.x, initial.y], 'movement is previewed without repeated storage writes');
    await page.mouse.up();
    await until(async () => (await readCache(page)).items.find(item => item.id === initial.id)?.x !== initial.x, 'released photo position is saved');
    const saved = (await readCache(page)).items.find(item => item.id === initial.id);
    assert(saved.y !== initial.y);
    assert.equal(saved.attachment_id, initial.attachment_id);
    assert.equal(saved.caption, initial.caption);
    await until(async () => (await rows(page)).some(row => row.op.type === 'goal_item_upsert' && row.op.payload.id === initial.id), 'released photo is durably queued');
    const beforeRows = await rows(page);
    assert.equal(beforeRows.filter(row => row.op.type === 'goal_item_upsert' && row.op.payload.id === initial.id).length, 1, 'one drag queues one save');
    assert.equal(await page.locator('.goals-photo-menu').count(), 0, 'a drag never opens photo actions');
    const next = await photo.boundingBox();
    await page.mouse.move(next.x + next.width / 2, next.y + next.height / 2);
    await page.mouse.down();
    await delay(520);
    await page.mouse.move(next.x + next.width / 2 + 20, next.y + next.height / 2 + 20, { steps: 5 });
    await photo.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true });
    await page.mouse.up();
    assert.deepEqual((await readCache(page)).items.find(item => item.id === initial.id), saved, 'cancelled preview never updates persisted position');
    assert.deepEqual(await rows(page), beforeRows, 'cancellation adds no new queued operation');
  });

  await scenario('failed image upload adds no phantom photo, then successful upload is reusable', async ({ page, opts, posts }) => {
    await chooseView(page, 'board');
    opts.failAttach = true;
    const initialItems = (await readCache(page)).items.length;
    await page.locator('#goals-photo-file').setInputFiles({ name: '試験画像.png', mimeType: 'image/png', buffer: Buffer.from(pixel, 'base64') });
    await until(() => posts.some(post => post.type === 'memo_attach'), 'upload reaches synthetic failure');
    await delay(150);
    assert.equal((await readCache(page)).items.length, initialItems, 'failed upload never creates an unresolved attachment reference');
    opts.failAttach = false;
    await page.locator('#goals-photo-file').setInputFiles({ name: '試験画像.png', mimeType: 'image/png', buffer: Buffer.from(pixel, 'base64') });
    await until(async () => (await readCache(page)).items.length === initialItems + 1, 'successful upload creates one photo');
    const saved = await readCache(page), added = saved.items.find(item => item.attachment_id.startsWith('uploaded-'));
    assert(added && added.id);
    assert.equal(added.mime, 'image/jpeg');
    assert.equal(added.name, '試験画像.jpg');
    const image = page.locator(`.board-photo[data-item-id="${added.id}"] .board-image`);
    await until(async () => image.evaluate(element => element.naturalWidth > 0), 'uploaded photo renders');
    const uploads = posts.filter(post => post.type === 'memo_attach');
    assert.equal(uploads.length, 2);
    assert.equal(uploads[1].mime, 'image/jpeg');
    assert.deepEqual([...Buffer.from(uploads[1].data, 'base64').subarray(0, 3)], [255, 216, 255]);
    assert.deepEqual(await legacyValues(page), legacy);
  });

  await scenario('regression cover selection can be turned off without changing its goal', async ({ page }) => {
    await chooseView(page, 'board');
    const photo = page.locator('.board-photo[data-item-id="photo-travel"]');
    await openPhotoEditor(page, photo);
    await page.locator('.image-placement-settings summary').click();
    await page.locator('#image-cover').check();
    await page.locator('#image-save').click();
    await page.locator('.goals-modal').waitFor({ state: 'detached' });
    assert.equal((await readCache(page)).nodes.find(node => node.id === 'goal-travel').cover_item_id, 'photo-travel');
    await openPhotoEditor(page, photo);
    await page.locator('.image-placement-settings summary').click();
    await page.locator('#image-cover').uncheck();
    await page.locator('#image-save').click();
    await page.locator('.goals-modal').waitFor({ state: 'detached' });
    const saved = await readCache(page);
    assert.equal(saved.nodes.find(node => node.id === 'goal-travel').cover_item_id, '', 'unchecking cover must clear the stored selection');
    assert.equal(saved.items.find(item => item.id === 'photo-travel').goal_id, 'goal-travel', 'photo remains linked to the same goal');
  });

  await scenario('regression upload completion preserves edits and the view chosen while waiting', async ({ page, opts, posts }) => {
    await chooseView(page, 'board');
    await page.locator('#board-goal-filter').selectOption('goal-work');
    opts.postDelay = 700;
    await page.locator('#goals-photo-file').setInputFiles({ name: '通信中の画像.png', mimeType: 'image/png', buffer: Buffer.from(pixel, 'base64') });
    await until(() => posts.some(post => post.type === 'memo_attach'), 'upload starts before concurrent edit');
    await page.evaluate(async () => (await import('/js/goals/repository.js')).saveNode({ id: 'goal-work', title: 'アップロード中に編集した目標', description: '新しい説明を保持する' }));
    await chooseView(page, 'purposes');
    await until(async () => {
      const cache = await readCache(page), item = cache.items.find(row => row.attachment_id.startsWith('uploaded-'));
      return item && cache.nodes.find(node => node.id === 'goal-work').cover_item_id === item.id;
    }, 'uploaded photo and cover update finish');
    const cache = await readCache(page), goal = cache.nodes.find(node => node.id === 'goal-work');
    const actual = { title: goal.title, description: goal.description, purposesVisible: await page.locator('[data-goals-view="purposes"]').getAttribute('aria-pressed'), openDialogs: await page.locator('.goals-modal').count() };
    assert.deepEqual(actual, { title: 'アップロード中に編集した目標', description: '新しい説明を保持する', purposesVisible: 'true', openDialogs: 0 }, 'upload must merge only its cover field and must not interrupt the current view');
    assert.deepEqual(await legacyValues(page), legacy);
  });

  await scenario('regression batch photo placement stays inside the saved board height', async ({ page }) => {
    await chooseView(page, 'board');
    const files = Array.from({ length: 6 }, (_, index) => ({ name: `追加画像${index + 1}.png`, mimeType: 'image/png', buffer: Buffer.from(pixel, 'base64') }));
    await page.locator('#goals-photo-file').setInputFiles(files);
    await until(async () => (await readCache(page)).items.filter(item => !item.deleted).length === 7, 'six new images join the existing image');
    const cache = await readCache(page), board = cache.boards.find(board => board.id === 'vision-main');
    const overflow = cache.items.filter(item => !item.deleted && item.board_id === board.id && Number(item.y) + Number(item.height) > Number(board.height)).map(item => ({ id: item.id, bottom: Number(item.y) + Number(item.height), boardHeight: board.height }));
    assert.deepEqual(overflow, [], 'every photo must fit inside the persisted board before it can be panned into view');
  });

  await scenario('photo actions open on a short tap without writing or deleting', async ({ page }) => {
    await chooseView(page, 'board');
    const before = await readCache(page), beforeRows = await rows(page);
    await page.locator('.board-photo[data-item-id="photo-travel"]').click();
    const menu = page.locator('.goals-photo-menu');
    await menu.waitFor({ state: 'visible', timeout: 2500 });
    assert(await page.getByRole('dialog', { name: '写真のメニュー', exact: true }).isVisible());
    assert(await page.locator('#photo-menu-edit').isVisible());
    assert(await page.locator('#photo-menu-layout').isVisible());
    assert(await page.locator('#photo-menu-remove').isVisible());
    assert.equal(await page.locator('#image-caption').count(), 0, 'a short tap opens actions before the edit form');
    assert.deepEqual(await readCache(page), before);
    assert.deepEqual(await rows(page), beforeRows);
    await page.locator('#photo-menu-close').click();
    await menu.waitFor({ state: 'detached' });
    assert.deepEqual(await readCache(page), before, 'closing actions never deletes a photo');
    assert.deepEqual(await rows(page), beforeRows);
    const photo = page.locator('.board-photo[data-item-id="photo-travel"]');
    await openPhotoEditor(page, photo, true);
    assert.equal(await page.locator('.image-placement-settings').evaluate(element => element.open), true, 'layout action opens rotation and size');
    await page.locator('.goals-modal [data-close]').click();
    await openPhotoEditor(page, photo);
    assert.equal(await page.locator('.image-placement-settings').evaluate(element => element.open), false, 'description action keeps placement controls folded');
    await page.locator('.goals-modal [data-close]').click();
    assert.deepEqual(await readCache(page), before);
    assert.deepEqual(await rows(page), beforeRows);
  });

  await scenario('photo gestures before the hold pan the board without saving or opening actions', async ({ page, opts }) => {
    opts.offline = true;
    await chooseView(page, 'board');
    const photo = page.locator('.board-photo[data-item-id="photo-travel"]');
    const before = await readCache(page), beforeRows = await rows(page);
    const transform = await page.locator('.board-stage').getAttribute('style');
    const box = await photo.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await delay(70);
    await page.mouse.move(box.x + box.width / 2 + 36, box.y + box.height / 2 + 32, { steps: 8 });
    await page.mouse.up();
    assert.deepEqual(await readCache(page), before, 'movement before 450ms changes viewing position only');
    assert.deepEqual(await rows(page), beforeRows);
    assert.notEqual(await page.locator('.board-stage').getAttribute('style'), transform, 'the board pans');
    assert.equal(await page.locator('.goals-photo-menu').count(), 0);
  });

  await scenario('photo held movement rolls back on Escape and pinch without enqueueing', async ({ page, opts }) => {
    opts.offline = true;
    await chooseView(page, 'board');
    const photo = page.locator('.board-photo[data-item-id="photo-travel"]');
    const before = await readCache(page), beforeRows = await rows(page);
    let box = await photo.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await delay(520);
    await page.mouse.move(box.x + box.width / 2 + 28, box.y + box.height / 2 + 24, { steps: 6 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    assert.deepEqual(await readCache(page), before, 'Escape reverts held preview');
    assert.deepEqual(await rows(page), beforeRows);
    box = await photo.boundingBox();
    const first = { pointerId: 501, pointerType: 'touch', clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, bubbles: true };
    await photo.dispatchEvent('pointerdown', first);
    await delay(520);
    const viewport = page.locator('.board-viewport');
    await viewport.dispatchEvent('pointermove', { ...first, clientX: first.clientX + 24, clientY: first.clientY + 22 });
    const second = { pointerId: 502, pointerType: 'touch', clientX: first.clientX + 80, clientY: first.clientY + 60, bubbles: true };
    await viewport.dispatchEvent('pointerdown', second);
    await viewport.dispatchEvent('pointermove', { ...second, clientX: second.clientX + 20, clientY: second.clientY + 20 });
    await viewport.dispatchEvent('pointercancel', second);
    assert.deepEqual(await readCache(page), before, 'pinch starting during a held preview reverts the photo position');
    assert.deepEqual(await rows(page), beforeRows);
    assert.equal(await page.locator('.goals-photo-menu').count(), 0);
  });

  const covered = clone(seed);
  covered.nodes.find(node => node.id === 'goal-travel').cover_item_id = 'photo-travel';
  await scenario('photo deletion can be cancelled and confirmed removal preserves its goal and attachment', async ({ page, posts, media }) => {
    await chooseView(page, 'board');
    const photo = page.locator('.board-photo[data-item-id="photo-travel"]');
    const before = await readCache(page), beforeRows = await rows(page);
    await photo.click();
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#photo-menu-remove').click();
    assert.deepEqual(await readCache(page), before, 'cancelled delete changes nothing');
    assert.deepEqual(await rows(page), beforeRows);
    if (await page.locator('.goals-photo-menu').isVisible()) await page.locator('#photo-menu-close').click();
    await photo.click();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#photo-menu-remove').click();
    await until(async () => !!(await readCache(page)).items.find(item => item.id === 'photo-travel')?.deleted, 'confirmed removal saves a tombstone');
    const cache = await readCache(page), item = cache.items.find(row => row.id === 'photo-travel'), goal = cache.nodes.find(node => node.id === 'goal-travel');
    assert.equal(item.attachment_id, 'attachment-travel');
    assert.equal(goal.deleted, 0);
    assert.equal(goal.title, '年に一度、ゆっくり旅をする');
    assert.equal(goal.cover_item_id, '');
    assert(media.has('attachment-travel'), 'binary attachment is retained');
    assert.equal(posts.filter(post => /attach.*delete|delete.*attach/.test(post.type)).length, 0);
    assert.deepEqual(await legacyValues(page), legacy);
  }, covered);

  if (!completed && !failures) throw new Error('No goals scenarios matched GOALS_TEST');
  console.log(`Goals browser checks: ${completed} passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  server.close();
});
