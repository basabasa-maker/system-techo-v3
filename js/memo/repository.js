// Only recovery metadata is stored here. Memo bodies stay in their existing cache.
const RECOVERY_KEY = 'sth_v3_memo_recovery';
const TYPES = new Set(['memo_upsert', 'memo_delete']);
let tokenSequence = 0;
const newToken = () => globalThis.crypto?.randomUUID?.()
  || `${Date.now()}-${++tokenSequence}-${Math.random().toString(36).slice(2)}`;
const corrupt = () => new Error('メモの復旧情報を確認できないため、取得や保存を中止しました。');

function readMarkers(storage) {
  const raw = storage.getItem(RECOVERY_KEY);
  if (raw === null) return [];
  let markers;
  try { markers = JSON.parse(raw); } catch (_) { throw corrupt(); }
  if (!Array.isArray(markers)) throw corrupt();
  const ids = new Set();
  for (const marker of markers) {
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)
        || Object.keys(marker).length !== 3
        || typeof marker.id !== 'string' || !marker.id
        || !TYPES.has(marker.type)
        || typeof marker.token !== 'string' || !marker.token || ids.has(marker.id)) throw corrupt();
    ids.add(marker.id);
  }
  return markers;
}

export function readMemoRecoveryIds(storage) {
  return new Set(readMarkers(storage).map(marker => marker.id));
}

export function createMemoRepository({ storage, queue: enqueue, loadMemo }) {
  function writeMarkers(markers) {
    storage.setItem(RECOVERY_KEY, JSON.stringify(markers));
  }
  function isCurrent(marker) {
    return readMarkers(storage).some(current => current.id === marker.id && current.token === marker.token);
  }
  function clearIfCurrent(marker) {
    // Another instance, edit or deletion may have replaced this operation.
    const latest = readMarkers(storage);
    const kept = latest.filter(current => current.id !== marker.id || current.token !== marker.token);
    if (kept.length !== latest.length) writeMarkers(kept);
  }
  function send(marker, op, delay) {
    // A synchronous enqueue exception also deliberately leaves the marker intact.
    return Promise.resolve(enqueue(op, delay)).then(result => {
      clearIfCurrent(marker);
      return result;
    });
  }
  function queue(op, delay = 1) {
    const id = op?.payload?.id;
    if (!TYPES.has(op?.type) || typeof id !== 'string' || !id) {
      throw new Error('メモの保存対象を確認できません。');
    }
    const markers = readMarkers(storage);
    const marker = { id, type: op.type, token: newToken() };
    // This must finish synchronously before IndexedDB persistence begins.
    writeMarkers([...markers.filter(current => current.id !== id), marker]);
    return send(marker, op, delay);
  }
  function getProtectedIds() {
    return readMemoRecoveryIds(storage);
  }
  async function replay() {
    const snapshot = readMarkers(storage);
    for (const marker of snapshot) {
      if (!isCurrent(marker)) continue;
      let payload = { id: marker.id };
      if (marker.type === 'memo_upsert') {
        payload = loadMemo(marker.id);
        if (!payload || payload.id !== marker.id || payload.deleted) {
          throw new Error('復旧するメモの本文を確認できないため、保存を中止しました。');
        }
      }
      // Use the existing token: an older replay cannot replace or clear a newer edit.
      if (!isCurrent(marker)) continue;
      await send(marker, { type: marker.type, payload }, 1);
    }
  }
  return { queue, getProtectedIds, replay };
}
