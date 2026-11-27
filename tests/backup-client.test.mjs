import test from 'node:test';
import assert from 'node:assert/strict';
import { getBackupStatus, backupAdminUrl, backupTimeLabel } from '../js/backup/client.js';

import { GAS_URL, BACKUP_ADMIN_URL } from '../js/config.js';

const response = data => ({ ok: true, text: async () => JSON.stringify({ ok: true, data }) });
test('backup status is a read-only request and exposes only public state', async () => {
  let sent;
  const result = await getBackupStatus({ fetch: async (url, options) => {
    sent = { url, options };
    return response({ enabled: true, hasBackups: true, lastSuccessAt: '2026-11-26T03:00:00+09:00', lastErrorCode: null, privateCopyId: 'do-not-copy', ownerEmail: 'do-not-copy@example.test' });
  }});
  assert.equal(new URL(sent.url).searchParams.get('type'), 'backup_status');
  assert.equal(new URL(sent.url).pathname, new URL(GAS_URL).pathname);
  assert.equal(sent.options.method, 'GET'); assert.equal(sent.options.cache, 'no-store');
  assert.equal(sent.options.body, undefined);
  assert.deepEqual(Object.keys(result).sort(), ['enabled','hasBackups','lastSuccessAt','lastErrorCode'].sort());
  assert(!JSON.stringify(result).includes('do-not-copy'));
});
test('unknown or failed server status never looks like a successful backup', async () => {
  for (const data of [{}, { enabled: true }, { enabled: 'true', hasBackups: true }, { enabled: false, hasBackups: false, lastSuccessAt: {} }]) {
    await assert.rejects(getBackupStatus({ fetch: async () => response(data) }), /確認できません/);
  }
  await assert.rejects(getBackupStatus({ fetch: async () => { throw new Error('private server detail'); } }), error => !error.message.includes('private server detail'));
});
test('Google management link does not carry record data, pairing keys or commands', () => {
  const url = new URL(backupAdminUrl());
  assert.deepEqual([...url.searchParams.entries()], [['type','backup_admin']]);
  assert(!url.hash);
  assert.equal(url.pathname, new URL(BACKUP_ADMIN_URL).pathname);
  assert.notEqual(url.pathname, new URL(GAS_URL).pathname, 'management uses the Google-restricted owner deployment');
  assert(!url.pathname.endsWith('/dev'), 'never administer against mutable development HEAD');
});
test('backup status times are shown in Japan time and invalid dates stay explicit', () => {
  assert.equal(backupTimeLabel(null), 'まだありません');
  assert.equal(backupTimeLabel('invalid'), '日時を確認できません');
  assert(backupTimeLabel('2026-11-25T18:00:00Z').includes('03:00'));
  assert(backupTimeLabel('2026-11-26 03:00:00').includes('03:00'), 'GAS JST stamp is not interpreted in the phone timezone');
});
