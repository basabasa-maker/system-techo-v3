// Health values travel in authenticated POST bodies, never launch/return URLs.
import * as gas from "../gas-client.js";
import { HEALTH_METRICS, healthBaseline, validateHealthResult } from "./model.js";

export const SETTINGS_KEY = "sth_v3_health_settings";
export const PENDING_KEY = "sth_v3_health_pending";
export const LAST_SYNC_KEY = "sth_v3_health_last_sync";
export const SHORTCUT_NAME = "システム手帳 ヘルスケア同期";
export const REQUEST_TTL_MS = 600000;
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function store(storage) { return storage || globalThis.localStorage; }
function jsonAt(storage, key) {
  const raw = storage.getItem(key);
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (_) { throw new Error("連携設定を読めません。保存済みデータを消さずに確認してください"); }
}
function validDate(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y,m,d] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(y,m-1,d));
  return y >= 2000 && y <= 2100 && parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m-1 && parsed.getUTCDate() === d;
}
function validRequest(request) {
  return request && KEY_PATTERN.test(request.request_id) && validDate(request.date)
    && Number.isFinite(request.issued_at) && request.issued_at > 0;
}
export function loadHealthSettings(storage) {
  const saved = jsonAt(store(storage), SETTINGS_KEY);
  const verifiedKeys = Array.isArray(saved?.verifiedKeys) ? saved.verifiedKeys.filter(key => Object.hasOwn(HEALTH_METRICS, key)) : [];
  return { enabled: saved?.enabled === true, shortcutName: saved?.shortcutName || SHORTCUT_NAME, pairKey: saved?.pairKey || "", verifiedKeys };
}
export function saveHealthSettings(settings, storage) {
  const target = store(storage), previous = loadHealthSettings(target);
  if (typeof settings.shortcutName !== "string" || !settings.shortcutName.trim() || settings.shortcutName.length > 100) throw new Error("ショートカット名を入力してください");
  if (settings.enabled && !KEY_PATTERN.test(settings.pairKey)) throw new Error("連携キーを確認してください");
  const verifiedKeys = settings.pairKey === previous.pairKey && Array.isArray(settings.verifiedKeys)
    ? [...new Set(settings.verifiedKeys.filter(key => Object.hasOwn(HEALTH_METRICS, key)))] : [];
  const next = { enabled: settings.enabled === true, shortcutName: settings.shortcutName.trim(), pairKey: settings.pairKey || "", verifiedKeys };
  target.setItem(SETTINGS_KEY, JSON.stringify(next));
  if (!next.enabled || next.pairKey !== previous.pairKey) target.removeItem(PENDING_KEY);
  return next;
}
export function generateHealthKey(crypto = globalThis.crypto) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join("")).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
export function createHealthBridge(options = {}) {
  const storage = () => store(options.storage);
  const now = options.now || (() => Date.now());
  const crypto = options.crypto || globalThis.crypto;
  const api = options.api || gas;
  function pending() {
    const request = jsonAt(storage(), PENDING_KEY);
    if (request === null) return null;
    if (!validRequest(request)) throw new Error("読み取り待ち情報が正しくありません。連携設定を確認してください");
    return request;
  }
  function fresh(request) {
    if (!validRequest(request) || now()-request.issued_at >= REQUEST_TTL_MS || request.issued_at-now() > 120000) throw new Error("ヘルスケアの読み取りが期限切れです。もう一度更新してください");
  }
  function credentials(request) {
    const settings = loadHealthSettings(storage());
    if (!settings.enabled || !KEY_PATTERN.test(settings.pairKey)) throw new Error("ヘルスケア連携が設定されていません");
    return { request_id: request.request_id, pair_key: settings.pairKey, date: request.date, issued_at: request.issued_at };
  }
  function prepare(date, values) {
    if (!validDate(date)) throw new Error("読み取る日付が正しくありません");
    const settings = loadHealthSettings(storage());
    if (!settings.enabled || !KEY_PATTERN.test(settings.pairKey)) throw new Error("先にヘルスケア連携を設定してください");
    const request = { request_id: generateHealthKey(crypto), date, issued_at: now(), baseline: healthBaseline(values), editedKeys: [] };
    storage().setItem(PENDING_KEY, JSON.stringify(request));
    const input = { request_id: request.request_id, date, issued_at: request.issued_at };
    const url = new URL("shortcuts://run-shortcut");
    url.searchParams.set("name", settings.shortcutName);
    url.searchParams.set("input", "text");
    url.searchParams.set("text", JSON.stringify(input));
    return { request, url: url.toString() };
  }
  async function read(request) {
    fresh(request);
    if (pending()?.request_id !== request.request_id) throw new Error("別の更新に切り替わりました");
    const result = await api.readHealthBridge(credentials(request));
    if (pending()?.request_id !== request.request_id) throw new Error("別の更新に切り替わりました");
    return validateHealthResult(result, request, now());
  }
  async function finish(request, keys = [], skipped = []) {
    if (pending()?.request_id !== request.request_id) return false;
    const body = credentials(request);
    storage().removeItem(PENDING_KEY);
    storage().setItem(LAST_SYNC_KEY, JSON.stringify({ date: request.date, synced_at: now(), keys, skipped }));
    try { await api.ackHealthBridge(body); } catch (_) { /* server cache expires without changing saved habits */ }
    return true;
  }
  function markEdited(key, date) {
    if (!Object.prototype.hasOwnProperty.call(HEALTH_METRICS, key)) return false;
    let request;
    try { request = pending(); } catch (_) { return false; }
    if (!request || request.date !== date) return false;
    request.editedKeys = [...new Set([...(request.editedKeys || []), key])];
    storage().setItem(PENDING_KEY, JSON.stringify(request));
    return true;
  }
  function cancel() { storage().removeItem(PENDING_KEY); }
  function lastSync() { return jsonAt(storage(), LAST_SYNC_KEY); }
  return { pending, prepare, read, finish, cancel, lastSync, markEdited };
}
export const healthBridge = createHealthBridge();
