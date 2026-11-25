// Updates never clear caches, discard queued writes, or resolve unfinished edits.
// The caller keeps its settings dialog open to prevent new background input.
import { hasPendingWrites } from '../gas-client.js';
import { hasPendingUploads } from '../memo/attachments.js';
import { hasPendingGoalPhotos } from '../goals.js';
import { healthBridge } from '../health/bridge.js';
import { pendingKeys } from '../sync.js';
import { count as outboxCount } from '../outbox.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function boundedRead(read, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('保存状況を確認できません。記録を残して更新を中止しました。')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function createUpdateSafety(options = {}) {
  const getDocument = () => options.document === undefined ? globalThis.document : options.document;
  const healthPending = options.healthPending || (() => healthBridge.pending());
  const apiBusy = options.apiBusy || hasPendingWrites;
  const uploadBusy = options.uploadBusy || hasPendingUploads;
  const goalUploadBusy = options.goalUploadBusy || hasPendingGoalPhotos;
  const readPending = options.pendingKeys || pendingKeys;
  const readCount = options.outboxCount || outboxCount;
  const delay = options.delay || wait;
  const settleMs = options.settleMs ?? 1000;
  const readTimeoutMs = options.readTimeoutMs ?? 5000;
  let settled = false;

  function assertIdle(doc) {
    if (!doc || typeof doc.querySelector !== 'function' || typeof doc.querySelectorAll !== 'function') {
      throw new Error('画面と保存状況を確認できないため、更新していません。');
    }
    if (doc.querySelector('.memo-detail')) {
      throw new Error('メモを閉じて一覧に戻り、保存が終わってからアプリを更新してください。');
    }
    const editingDialog = Array.from(doc.querySelectorAll('.modal-backdrop')).some(dialog => !dialog.classList?.contains('app-settings-modal'));
    if (editingDialog) throw new Error('編集中の画面を保存して閉じてから、アプリを更新してください。');
    if (uploadBusy() || goalUploadBusy()) throw new Error('写真・添付を保存しています。完了してからアプリを更新してください。');
    if (healthPending()) throw new Error('ヘルスケアの取り込みが途中です。完了または中止してからアプリを更新してください。');
    if (apiBusy()) throw new Error('記録を保存・通信しています。完了してからアプリを更新してください。');
  }
  function checkPending(value) {
    if (!(value instanceof Set)) throw new Error('未送信の記録を確認できないため、更新していません。');
    return value.size;
  }
  const prepare = async () => {
    const doc = getDocument();
    const focused = doc?.activeElement;
    if (focused && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName || '')) focused.blur();
    assertIdle(doc);
    if (!settled) {
      await delay(settleMs);
      settled = true;
    }
    assertIdle(doc);
    const firstPending = checkPending(await boundedRead(readPending, readTimeoutMs));
    const queued = await boundedRead(readCount, readTimeoutMs);
    if (!Number.isInteger(queued) || queued < 0) throw new Error('未送信の記録を確認できないため、更新していません。');
    // A write may have entered staging while the IndexedDB count was awaited.
    const lastPending = checkPending(await boundedRead(readPending, readTimeoutMs));
    assertIdle(doc);
    if (firstPending || queued || lastPending) {
      throw new Error('未送信の記録が残っています。同期が完了してからアプリを更新してください。記録は端末に残しています。');
    }
    return true;
  };
  prepare.reset = () => { settled = false; };
  return prepare;
}

export const prepareForAppUpdate = createUpdateSafety();
