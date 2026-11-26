// All Google services are stubs. This test never connects to GAS, Drive or Sheets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sourcePath = path.resolve(__dirname, '../gas/Backup.gs');
const handler = 'systemTechoBackupDaily_';
const configKey = 'sth_v3_backup_config';
const copyPrefix = 'sth_v3_backup_copy_';
function harness() {
  const properties = new Map([['unrelated', 'untouched']]);
  const options = { active: 'owner@example.test', effective: 'owner@example.test', lock: true, day: '2026-11-26', copyFailure: false, verifyFailure: false, registryFailure: false, triggerFailure: false, enableStateFailure: false, onCopy: null };
  const calls = { copied: [], deleted: [], schedule: [], html: 0, sourceReads: 0, released: 0, writes: [] };
  let triggers = [], sequence = 0, locked = false;
  const sheet = name => ({ getName: () => name });
  const sheets = ['tasks', 'memo', 'habit_days', 'habit_items', 'meals', 'メモ添付', 'goal_nodes', 'goal_boards', 'goal_board_items', 'future_extra'];
  const trigger = (id, fn = handler) => ({ getUniqueId: () => id, getHandlerFunction: () => fn });
  const store = {
    getProperty: key => properties.get(key) ?? null,
    setProperty(key, value) {
      if (options.enableStateFailure && key === configKey && JSON.parse(value).enabled) throw new Error('synthetic enable state failure');
      if (options.registryFailure && key.startsWith(copyPrefix)) throw new Error('synthetic registry secret');
      properties.set(key, String(value)); calls.writes.push(key); return this;
    },
    getProperties: () => Object.fromEntries(properties),
  };
  const context = vm.createContext({
    SPREADSHEET_ID: 'source-spreadsheet',
    Session: { getActiveUser: () => ({ getEmail: () => options.active }), getEffectiveUser: () => ({ getEmail: () => options.effective }) },
    PropertiesService: { getScriptProperties: () => store },
    LockService: { getScriptLock: () => ({ tryLock: () => { if (!options.lock || locked) return false; locked = true; return true; }, releaseLock: () => { locked = false; calls.released++; } }) },
    SpreadsheetApp: { openById(id) {
      assert.equal(id, 'source-spreadsheet'); calls.sourceReads++;
      return {
        getSheets: () => sheets.map(sheet),
        copy(name) {
          if (options.onCopy) options.onCopy();
          if (options.copyFailure) throw new Error('private-source-id health body secret');
          const id = 'created-copy-' + ++sequence;
          calls.copied.push({ id, name });
          return { getId: () => id, getSheets: () => (options.verifyFailure ? ['memo'] : sheets).map(sheet) };
        },
      };
    } },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger(t) { calls.deleted.push(t.getUniqueId()); triggers = triggers.filter(x => x !== t); },
      newTrigger(fn) {
        assert.equal(fn, handler);
        const schedule = {};
        const builder = {
          timeBased() { schedule.clock = true; return this; }, atHour(hour) { schedule.hour = hour; return this; },
          everyDays(days) { schedule.days = days; return this; }, inTimezone(tz) { schedule.tz = tz; return this; },
          create() { if (options.triggerFailure) throw new Error('private trigger detail'); const t = trigger('trigger-' + ++sequence, fn); triggers.push(t); calls.schedule.push(schedule); return t; },
        }; return builder;
      },
    },
    HtmlService: { createHtmlOutputFromFile(file) { assert.equal(file, 'BackupAdmin'); calls.html++; return { setTitle: () => ({ ownerHtml: true }) }; } },
    Utilities: { formatDate: (_date, tz, format) => { assert.equal(tz, 'Asia/Tokyo'); return format === 'yyyy-MM-dd' ? options.day : options.day + ' 03:12:34'; } },
    Date,
  });
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context);
  return { context, options, calls, properties, sheets, addTrigger: (id, fn) => triggers.push(trigger(id, fn)), getTriggers: () => triggers, config: () => JSON.parse(properties.get(configKey) || 'null'), records: () => [...properties].filter(([key]) => key.startsWith(copyPrefix)).map(([, value]) => JSON.parse(value)) };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('anonymous status is generic, defaults disabled, and never creates or reads a workbook', () => {
  const h = harness(); h.options.active = '';
  assert.deepEqual(plain(h.context.getBackupStatus()), { enabled: false, lastSuccessAt: '', lastErrorCode: '', hasBackups: false });
  assert.equal(h.calls.copied.length, 0); assert.equal(h.calls.sourceReads, 0); assert.deepEqual(h.calls.writes, []);
});

test('every owner entry rejects blank or different active identity before services mutate', () => {
  for (const active of ['', 'visitor@example.test']) {
    for (const name of ['renderBackupAdminPage', 'getBackupAdminState', 'configureAutomaticBackups', 'runBackupNow']) {
      const h = harness(); h.options.active = active;
      assert.throws(() => h.context[name](true), /管理者/);
      assert.equal(h.calls.html, 0); assert.deepEqual(h.calls.writes, []); assert.equal(h.calls.schedule.length, 0); assert.equal(h.calls.copied.length, 0);
    }
  }
});

test('owner admin HTML is gated and uses the dedicated file', () => {
  const h = harness(); assert.deepEqual(plain(h.context.renderBackupAdminPage()), { ownerHtml: true }); assert.equal(h.calls.html, 1);
});

test('enable is idempotent and creates only the daily JST 3-hour trigger', () => {
  const h = harness(); h.addTrigger('other-task', 'unrelatedHandler');
  h.context.configureAutomaticBackups(true); h.context.configureAutomaticBackups(true);
  assert.equal(h.calls.schedule.length, 1);
  assert.deepEqual(h.calls.schedule[0], { clock: true, hour: 3, days: 1, tz: 'Asia/Tokyo' });
  assert.equal(h.config().enabled, true); assert.equal(h.getTriggers().length, 2);
  assert.deepEqual(h.calls.deleted, []); assert.equal(h.properties.get('unrelated'), 'untouched');
});

test('disable removes only the recorded trigger whose handler matches', () => {
  const h = harness(); h.context.configureAutomaticBackups(true); const own = h.config().triggerUid;
  h.addTrigger('other-task', 'unrelatedHandler'); h.addTrigger('older-unrecorded', handler);
  h.context.configureAutomaticBackups(false);
  assert.deepEqual(h.calls.deleted, [own]); assert.equal(h.getTriggers().length, 2); assert.equal(h.config().enabled, false);
});

test('a stored UID with another handler is never deleted', () => {
  const h = harness(); h.context.configureAutomaticBackups(true); const own = h.getTriggers()[0];
  own.getHandlerFunction = () => 'unrelatedHandler';
  h.context.configureAutomaticBackups(false); assert.deepEqual(h.calls.deleted, []);
});

test('manual copy includes every sheet and records only the created copy', () => {
  const h = harness(); const result = h.context.runBackupNow();
  assert.equal(h.calls.copied.length, 1); assert.equal(h.records().length, 1);
  assert.equal(h.records()[0].id, h.calls.copied[0].id); assert.equal(h.records()[0].status, 'verified');
  assert.equal(result.lastSuccessAt, '2026-11-26 03:12:34'); assert.equal(result.hasBackups, true);
  assert.equal(h.properties.get('unrelated'), 'untouched'); assert.equal(h.config().enabled, false);
  assert.deepEqual(h.calls.deleted, []);
});

test('anonymous status after a copy exposes no identifiers, URLs, email or registry', () => {
  const h = harness(); h.context.runBackupNow(); h.options.active = '';
  const status = h.context.getBackupStatus(), serialized = JSON.stringify(status);
  assert.deepEqual(Object.keys(status).sort(), ['enabled', 'hasBackups', 'lastErrorCode', 'lastSuccessAt']);
  for (const sensitive of ['source-spreadsheet', 'created-copy-', 'owner@example.test', 'https:', 'backups', 'triggerUid']) assert.ok(!serialized.includes(sensitive));
});

test('unknown, absent and wrong-owner timer events cannot create or alter backups', () => {
  const h = harness(); h.context.configureAutomaticBackups(true); const before = [...h.properties], copiedBefore = h.calls.copied.length;
  h.context.systemTechoBackupDaily_(); h.context.systemTechoBackupDaily_({ triggerUid: 'wrong' });
  h.options.effective = 'new-owner@example.test'; h.context.systemTechoBackupDaily_({ triggerUid: h.config().triggerUid });
  assert.equal(h.calls.copied.length, copiedBefore); assert.deepEqual([...h.properties], before);
});

test('timer is permitted without active email, runs once daily, and stops after disabling', () => {
  const h = harness(); h.context.configureAutomaticBackups(true); const uid = h.config().triggerUid; h.options.active = ''; h.options.day = '2026-11-27';
  h.context.systemTechoBackupDaily_({ triggerUid: uid }); h.context.systemTechoBackupDaily_({ triggerUid: uid });
  assert.equal(h.calls.copied.length, 2);
  h.options.active = 'owner@example.test'; h.context.configureAutomaticBackups(false); h.context.systemTechoBackupDaily_({ triggerUid: uid });
  assert.equal(h.calls.copied.length, 2);
});

test('copy failure retains the earlier success and exposes only a stable error code', () => {
  const h = harness(); h.context.runBackupNow(); const successful = h.config().lastSuccessAt;
  h.options.copyFailure = true; assert.throws(() => h.context.runBackupNow(), /コピー/);
  const status = plain(h.context.getBackupStatus()); assert.equal(status.lastSuccessAt, successful); assert.equal(status.lastErrorCode, 'COPY_FAILED');
  assert.equal(h.records().length, 1); assert.ok(!JSON.stringify(status).includes('secret'));
});

test('failed verification never reports an unverified copy as a successful backup', () => {
  const h = harness(); h.options.verifyFailure = true; assert.throws(() => h.context.runBackupNow(), /確認/);
  assert.equal(h.context.getBackupStatus().lastSuccessAt, ''); assert.equal(h.context.getBackupStatus().hasBackups, false);
  assert.equal(h.context.getBackupStatus().lastErrorCode, 'VERIFY_FAILED'); assert.equal(h.records()[0].status, 'created');
});

test('registry failure does not fake a successful backup or touch other properties', () => {
  const h = harness(); h.options.registryFailure = true; assert.throws(() => h.context.runBackupNow(), /記録/);
  assert.equal(h.context.getBackupStatus().lastSuccessAt, ''); assert.equal(h.context.getBackupStatus().lastErrorCode, 'REGISTRY_FAILED');
  assert.equal(h.properties.get('unrelated'), 'untouched');
});

test('locked/concurrent operations cannot create copies or change settings', () => {
  const h = harness(); h.options.lock = false;
  assert.throws(() => h.context.runBackupNow(), /処理中/); assert.throws(() => h.context.configureAutomaticBackups(true), /処理中/);
  assert.equal(h.calls.copied.length, 0); assert.equal(h.calls.schedule.length, 0); assert.equal(h.properties.size, 1);
});

test('a trigger-creation failure leaves backups disabled and does not delete unrelated triggers', () => {
  const h = harness(); h.addTrigger('other-task', 'unrelatedHandler'); h.options.triggerFailure = true;
  assert.throws(() => h.context.configureAutomaticBackups(true), /設定/);
  assert.equal(h.context.getBackupStatus().enabled, false); assert.deepEqual(h.calls.deleted, []);
  assert.equal(h.records().length, 1); assert.equal(h.records()[0].status, 'verified');
});

test('invalid config fails closed; owner operations do not overwrite it', () => {
  const h = harness(); h.properties.set(configKey, '{corrupt'); const before = [...h.properties];
  assert.equal(h.context.getBackupStatus().lastErrorCode, 'STATE_INVALID');
  assert.throws(() => h.context.configureAutomaticBackups(true), /設定/); assert.throws(() => h.context.runBackupNow(), /設定/);
  assert.deepEqual([...h.properties], before); assert.equal(h.calls.copied.length, 0);
});

test('invalid enable arguments cannot change configuration', () => {
  const h = harness(); for (const input of ['true', 1, null, {}]) assert.throws(() => h.context.configureAutomaticBackups(input), /設定/);
  assert.equal(h.calls.schedule.length, 0); assert.equal(h.properties.size, 1);
});

test('enable never creates a trigger or reports ON if the initial copy fails', () => {
  const h = harness(); h.options.copyFailure = true;
  assert.throws(() => h.context.configureAutomaticBackups(true), /コピー/);
  assert.equal(h.context.getBackupStatus().enabled, false);
  assert.equal(h.context.getBackupStatus().lastSuccessAt, '');
  assert.equal(h.calls.schedule.length, 0); assert.equal(h.records().length, 0);
});

test('failed final enable-state write cleans up only the just-created trigger and retains its verified copy', () => {
  const h = harness(); h.options.enableStateFailure = true; h.addTrigger('other-job', 'otherHandler');
  assert.throws(() => h.context.configureAutomaticBackups(true), /設定/);
  assert.equal(h.context.getBackupStatus().enabled, false);
  assert.equal(h.records().length, 1); assert.equal(h.records()[0].status, 'verified');
  assert.equal(h.calls.deleted.length, 1); assert.notEqual(h.calls.deleted[0], 'other-job');
  assert.equal(h.getTriggers().length, 1); assert.equal(h.getTriggers()[0].getUniqueId(), 'other-job');
});

test('reentrant copy/configure attempts fail under the same lock while one copy completes', () => {
  const h = harness(); let nested = 0;
  h.options.onCopy = () => {
    nested++;
    assert.throws(() => h.context.runBackupNow(), /処理中/);
    assert.throws(() => h.context.configureAutomaticBackups(true), /処理中/);
  };
  h.context.runBackupNow();
  assert.equal(nested, 1); assert.equal(h.calls.copied.length, 1); assert.equal(h.calls.schedule.length, 0);
  assert.equal(h.calls.released, 1); assert.equal(h.records()[0].status, 'verified');
});

test('public server surface has no restore, delete, ID-based lookup or worker bypass', () => {
  const names = [...fs.readFileSync(sourcePath, 'utf8').matchAll(/^function\s+(\w+)\s*\(/gm)].map(match => match[1]).filter(name => !name.endsWith('_')).sort();
  assert.deepEqual(names, ['configureAutomaticBackups', 'getBackupAdminState', 'getBackupStatus', 'renderBackupAdminPage', 'runBackupNow']);
});

test('admin HTML renders with text nodes and uses only owner RPCs without any key input', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../gas/BackupAdmin.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const nodes = new Map(), calls = [];
  function node() {
    const value = { textContent: '', children: [], disabled: false, checked: false, listeners: {}, classList: { toggle() {} },
      replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); }, addEventListener(name, callback) { this.listeners[name] = callback; } };
    Object.defineProperty(value, 'innerHTML', { set() { throw new Error('unsafe HTML'); } }); return value;
  }
  const document = { getElementById: id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node };
  let enabled = false, failConfigure = false;
  const result = () => ({ enabled, lastSuccessAt: '2026-11-26 03:12:34', lastErrorCode: '', hasBackups: true, backupCount: 1,
    backups: [{ id: 'created-copy-safe', createdAt: '<b>literal timestamp</b>', cause: 'manual', status: 'verified' }] });
  const google = { script: {} };
  Object.defineProperty(google.script, 'run', { get() {
    let success, failure;
    const runner = {
      withSuccessHandler(fn) { success = fn; return this; }, withFailureHandler(fn) { failure = fn; return this; },
      getBackupAdminState() { calls.push('state'); success(result()); },
      runBackupNow() { calls.push('copy'); success(result()); },
      configureAutomaticBackups(value) { calls.push(['configure', value]); if (failConfigure) failure({ message: '設定に失敗' }); else { enabled = value; success(result()); } },
    }; return runner;
  } });
  vm.runInNewContext(script, { document, google });
  assert.equal(nodes.get('automatic').checked, false); assert.equal(nodes.get('copy-now').disabled, false);
  nodes.get('automatic').checked = true; nodes.get('automatic').listeners.change();
  assert.equal(nodes.get('automatic').checked, true);
  nodes.get('copy-now').listeners.click();
  failConfigure = true; nodes.get('automatic').checked = false; nodes.get('automatic').listeners.change();
  assert.equal(nodes.get('automatic').checked, true, 'failed toggle restores server state');
  assert.equal(nodes.get('message').textContent, '設定に失敗');
  const link = nodes.get('copies').children[0].children[0];
  assert.equal(link.textContent, '<b>literal timestamp</b>（日本時間）のコピーを開く');
  assert.equal(link.href, 'https://docs.google.com/spreadsheets/d/created-copy-safe/edit');
  assert.equal(link.rel, 'noopener noreferrer'); assert.ok(calls.includes('copy'));
  assert(!/<input[^>]+type=["'](?:password|text)["']/i.test(html));
  assert(!/src=["']https?:/i.test(html));
});

test('corrupt or unregistered backup metadata is not rendered or overwritten by mutations', () => {
  const h = harness(); h.properties.set(copyPrefix + 'bad', JSON.stringify({ id: 'source-spreadsheet', sourceId: 'source-spreadsheet', createdAt: '2026-11-26 03:12:34', name: 'bad', cause: 'manual', status: 'verified' }));
  const before = [...h.properties];
  assert.throws(() => h.context.getBackupAdminState(), /設定/);
  assert.throws(() => h.context.runBackupNow(), /設定/);
  assert.throws(() => h.context.configureAutomaticBackups(true), /設定/);
  assert.deepEqual([...h.properties], before); assert.equal(h.calls.copied.length, 0);
});

test('missing effective identity fails closed as well as missing active identity', () => {
  const h = harness(); h.options.effective = '';
  assert.throws(() => h.context.runBackupNow(), /管理者/);
  assert.throws(() => h.context.configureAutomaticBackups(true), /管理者/);
  assert.equal(h.calls.copied.length, 0); assert.equal(h.properties.size, 1);
});
