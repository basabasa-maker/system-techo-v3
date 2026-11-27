// Health values travel in authenticated POST bodies, never launch/return URLs.
import * as gas from "../gas-client.js";
import { HEALTH_METRICS, healthBaseline, validateHealthResult } from "./model.js";
import { HEALTH_SHORTCUT_NAME, HEALTH_SHORTCUT_PROTOCOL_VERSION } from "./release.js";

export const SETTINGS_KEY = "sth_v3_health_settings";
export const PENDING_KEY = "sth_v3_health_pending";
// Old app instances only inspect PENDING_KEY and must never import a diagnosis.
export const INSPECTION_PENDING_KEY = "sth_v3_health_inspection_pending";
export const LAST_SYNC_KEY = "sth_v3_health_last_sync";
export const LAST_RECEIPT_KEY = "sth_v3_health_last_receipt";
export const SHORTCUT_NAME = HEALTH_SHORTCUT_NAME;
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
function validMode(mode) { return mode === undefined || mode === "inspect"; }
function validRequest(request) {
  return request && KEY_PATTERN.test(request.request_id) && validDate(request.date)
    && Number.isFinite(request.issued_at) && request.issued_at > 0 && validMode(request.mode);
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
  if (next.shortcutName !== previous.shortcutName || next.pairKey !== previous.pairKey) target.removeItem(LAST_RECEIPT_KEY);
  if (!next.enabled || next.pairKey !== previous.pairKey) {
    target.removeItem(PENDING_KEY);
    target.removeItem(INSPECTION_PENDING_KEY);
  }
  return next;
}
function validReleaseMetadata(data) {
  const versioned=Object.hasOwn(data,"shortcutVersion"), protocol=Object.hasOwn(data,"protocolVersion");
  if (versioned !== protocol || (versioned && (typeof data.shortcutVersion !== "string" || data.shortcutVersion.length > 32
    || !/^\d+\.\d+\.\d+$/.test(data.shortcutVersion) || /[\r\n]/.test(data.shortcutVersion)
    || data.protocolVersion !== HEALTH_SHORTCUT_PROTOCOL_VERSION))) throw new Error("ショートカットの版情報が正しくありません");
  return versioned ? {shortcutVersion:data.shortcutVersion,protocolVersion:data.protocolVersion} : {};
}
export function loadHealthReceipt(storage) {
  try {
    const target=store(storage), receipt=jsonAt(target,LAST_RECEIPT_KEY);
    if (!receipt || receipt.shortcutName !== loadHealthSettings(target).shortcutName || !Number.isFinite(receipt.received_at) || receipt.received_at <= 0) return null;
    if (receipt.shortcutVersion !== null || receipt.protocolVersion !== null) validReleaseMetadata(receipt);
    if (receipt.stepsSource !== null && receipt.stepsSource !== "apple_watch") return null;
    return {shortcutName:receipt.shortcutName,received_at:receipt.received_at,stepsSource:receipt.stepsSource,
      shortcutVersion:receipt.shortcutVersion,protocolVersion:receipt.protocolVersion};
  } catch (_) { return null; }
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
  function pendingAt(key, mode) {
    const request = jsonAt(storage(), key);
    if (request === null) return null;
    if (!validRequest(request) || request.mode !== mode) throw new Error("読み取り待ち情報が正しくありません。連携設定を確認してください");
    return request;
  }
  function pending() {
    // A normal request from another app instance takes precedence. A hidden
    // inspection cannot be read or completed while that request is pending.
    return pendingAt(PENDING_KEY, undefined) || pendingAt(INSPECTION_PENDING_KEY, "inspect");
  }
  function fresh(request) {
    if (!validRequest(request) || now()-request.issued_at >= REQUEST_TTL_MS || request.issued_at-now() > 120000) throw new Error("ヘルスケアの読み取りが期限切れです。もう一度更新してください");
  }
  function credentials(request) {
    const settings = loadHealthSettings(storage());
    if (!settings.enabled || !KEY_PATTERN.test(settings.pairKey)) throw new Error("ヘルスケア連携が設定されていません");
    return { request_id: request.request_id, pair_key: settings.pairKey, date: request.date, issued_at: request.issued_at };
  }
  function prepare(date, values, { mode } = {}) {
    if (!validMode(mode)) throw new Error("読み取りモードが正しくありません。");
    if (!validDate(date)) throw new Error("読み取る日付が正しくありません");
    const settings = loadHealthSettings(storage());
    if (!settings.enabled || !KEY_PATTERN.test(settings.pairKey)) throw new Error("先にヘルスケア連携を設定してください");
    if (mode === "inspect" && pending()) throw new Error("読み取り待ちの更新があります。完了または中止してから確認してください");
    const request = { request_id: generateHealthKey(crypto), date, issued_at: now(), baseline: healthBaseline(values), editedKeys: [] };
    if (mode === "inspect") {
      request.mode = mode; // Local only; never sent to Shortcuts or GAS.
      storage().setItem(INSPECTION_PENDING_KEY, JSON.stringify(request));
    } else {
      storage().setItem(PENDING_KEY, JSON.stringify(request));
      storage().removeItem(INSPECTION_PENDING_KEY);
    }
    const input = { request_id: request.request_id, date, issued_at: request.issued_at };
    const url = new URL("shortcuts://run-shortcut");
    url.searchParams.set("name", settings.shortcutName);
    url.searchParams.set("input", "text");
    url.searchParams.set("text", JSON.stringify(input));
    // Shortcuts uses percent decoding, not form decoding: spaces must be %20.
    // Literal plus signs have already been escaped as %2B by URLSearchParams.
    url.search = url.searchParams.toString().replace(/\+/g, "%20");
    return { request, url: url.toString() };
  }
  async function readSnapshot(request) {
    fresh(request);
    if (pending()?.request_id !== request.request_id) throw new Error("別の更新に切り替わりました");
    const result = await api.readHealthBridge(credentials(request));
    if (pending()?.request_id !== request.request_id) throw new Error("別の更新に切り替わりました");
    const values = validateHealthResult(result, request, now());
    if (values === null) return null;
    if (Object.hasOwn(result, "stepsSource") && result.stepsSource !== "apple_watch") throw new Error("歩数の取得元が正しくありません");
    const release=validReleaseMetadata(result);
    // Connection metadata contains no measurement, key or requested health date.
    const receipt={shortcutName:loadHealthSettings(storage()).shortcutName,received_at:now(),stepsSource:result.stepsSource ?? null,
      shortcutVersion:release.shortcutVersion ?? null,protocolVersion:release.protocolVersion ?? null};
    try { storage().setItem(LAST_RECEIPT_KEY,JSON.stringify(receipt)); } catch (_) { /* A full cache leaves the version unconfirmed, without blocking valid measurements. */ }
    return {values, ...(Object.hasOwn(result, "stepsSource") ? {stepsSource:result.stepsSource} : {}), ...release};
  }
  async function read(request) {
    const result = await readSnapshot(request);
    return result === null ? null : result.values;
  }
  async function finish(request, keys = [], skipped = [], { recordSync = true } = {}) {
    if (!validMode(request?.mode) || typeof recordSync !== "boolean") throw new Error("読み取り完了の設定が正しくありません。");
    const current = pending();
    if (current?.request_id !== request.request_id) return false;
    const body = credentials(request);
    if (current.mode === "inspect") storage().removeItem(INSPECTION_PENDING_KEY);
    else {
      storage().removeItem(PENDING_KEY);
      storage().removeItem(INSPECTION_PENDING_KEY);
    }
    // Persisted mode also protects a resumed caller that omits the new option
    // or loses mode while rebuilding its request object.
    if (recordSync && current.mode !== "inspect" && request.mode !== "inspect") {
      storage().setItem(LAST_SYNC_KEY, JSON.stringify({ date: request.date, synced_at: now(), keys, skipped }));
    }
    try { await api.ackHealthBridge(body); } catch (_) { /* server cache expires without changing saved habits */ }
    return true;
  }
  function markEdited(key, date) {
    if (!Object.prototype.hasOwnProperty.call(HEALTH_METRICS, key)) return false;
    let request;
    try { request = pending(); } catch (_) { return false; }
    if (!request || request.date !== date) return false;
    request.editedKeys = [...new Set([...(request.editedKeys || []), key])];
    storage().setItem(request.mode === "inspect" ? INSPECTION_PENDING_KEY : PENDING_KEY, JSON.stringify(request));
    return true;
  }
  function cancel() {
    storage().removeItem(PENDING_KEY);
    storage().removeItem(INSPECTION_PENDING_KEY);
  }
  function lastSync() { return jsonAt(storage(), LAST_SYNC_KEY); }
  return { pending, prepare, read, readSnapshot, finish, cancel, lastSync, lastReceipt:()=>loadHealthReceipt(storage()), markEdited };
}
export const healthBridge = createHealthBridge();
