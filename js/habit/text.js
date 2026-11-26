import * as sync from "../sync.js";
import { LS_KEY_HABIT_DAY_PREFIX } from "../config.js";

// Native multiline editing. Never replace the field, move its caret, or consume Enter.
// A successful local commit becomes the baseline, so unchanged CRLF data is not
// rewritten merely because textarea normalizes its display to LF.
const textVersions = new Map();
// Other input types can replace a formerly textual field without creating a
// new text controller. Invalidate only bookkeeping for fields we have bound.
export function markHabitValueChanged(date, id) {
  const key = date + ":" + id;
  if (textVersions.has(key)) textVersions.set(key, textVersions.get(key) + 1);
}
export function invalidateHabitTextItem(id) {
  for (const [key, version] of textVersions) {
    if (key.slice(11) === id) textVersions.set(key, version + 1);
  }
}
export function bindHabitTextInput(input, { key, commit, onError }) {
  if (!textVersions.has(key)) textVersions.set(key, 0);
  let ownVersion = textVersions.get(key);
  let baseline = input.value;
  let warned = false;
  const flush = () => {
    if (input.value === baseline) return true;
    // Late native composition events can still target a detached old textarea.
    // Preserve them unless a newer session has edited this exact day/id.
    if (!input.isConnected && ownVersion !== (textVersions.get(key) || 0)) return true;
    try {
      commit(input.value);
      ownVersion = (textVersions.get(key) || 0) + 1;
      textVersions.set(key, ownVersion);
      baseline = input.value;
      warned = false;
      return true;
    } catch (error) {
      if (!warned) onError(error);
      warned = true;
      return false;
    }
  };
  const update = () => {
    flush();
    input.classList.toggle("filled", input.value !== "");
    const clear = input.closest(".habit-item")?.querySelector(".habit-clear");
    if (clear) clear.hidden = input.value === "";
  };
  input.addEventListener("input", update);
  input.addEventListener("change", update);
  input.addEventListener("compositionend", update);
  input.addEventListener("blur", update);
  return { flush, isDirty: () => input.value !== baseline };
}

const RECOVERY_KEY = "sth_v3_habit_text_recovery";
const markerId = marker => marker.date + ":" + marker.id;
const recoveryError = () => new Error("文章の復旧情報を確認できないため、取得と送信を中止しました。");
function readMarkers(storage = globalThis.localStorage) {
  const raw = storage.getItem(RECOVERY_KEY);
  if (raw === null) return [];
  let markers;
  try { markers = JSON.parse(raw); } catch (_) { throw recoveryError(); }
  if (!Array.isArray(markers)) throw recoveryError();
  const seen = new Set();
  for (const marker of markers) {
    if (!marker || typeof marker !== "object" || Array.isArray(marker)
        || Object.keys(marker).length !== 5
        || !/^\d{4}-\d{2}-\d{2}$/.test(marker.date)
        || typeof marker.id !== "string" || !marker.id
        || !["set", "del"].includes(marker.kind)
        || typeof marker.value !== "string" || (marker.kind === "del") !== (marker.value === "")
        || typeof marker.token !== "string" || !marker.token
        || seen.has(markerId(marker))) throw recoveryError();
    seen.add(markerId(marker));
  }
  return markers;
}
// Readonly: settings and history use this synchronously before replacing caches.
export function getHabitTextRecoveryDates(storage = globalThis.localStorage) {
  return new Set(readMarkers(storage).map(marker => marker.date));
}
function writeMarkers(markers) {
  localStorage.setItem(RECOVERY_KEY, JSON.stringify(markers));
}
function isCurrent(marker) {
  return readMarkers().some(current => markerId(current) === markerId(marker) && current.token === marker.token);
}
function clearIfCurrent(marker) {
  const markers = readMarkers();
  const kept = markers.filter(current => markerId(current) !== markerId(marker) || current.token !== marker.token);
  if (kept.length !== markers.length) writeMarkers(kept);
}
function sendMarker(marker, patch) {
  return Promise.resolve().then(() => sync.queue({ type: "habit_day_upsert", payload: {
    date: marker.date, ...patch,
  } }, 700, { durableRecovery: true })).then(result => {
    clearIfCurrent(marker);
    return result;
  });
}
// The intended value is durable before the day cache and must match it on replay.
// There is no async gap until
// both writes finish; a local-write exception restores the previous marker.
export function persistHabitText(date, id, value, writeLocal) {
  const previous = readMarkers();
  const marker = { date, id, kind: value === "" ? "del" : "set", value, token: crypto.randomUUID() };
  writeMarkers([...previous.filter(old => markerId(old) !== markerId(marker)), marker]);
  try { writeLocal(); }
  catch (error) {
    // Do not discard a marker for another text field/date.
    if (isCurrent(marker)) {
      const others = readMarkers().filter(current => markerId(current) !== markerId(marker));
      const old = previous.find(current => markerId(current) === markerId(marker));
      writeMarkers(old ? [...others, old] : others);
    }
    throw error;
  }
  return sendMarker(marker, value === "" ? { set: {}, del: [id] } : { set: { [id]: value }, del: [] });
}
export async function replayHabitTextRecovery() {
  for (const marker of readMarkers()) {
    if (!isCurrent(marker)) continue;
    let values;
    try {
      const raw = localStorage.getItem(LS_KEY_HABIT_DAY_PREFIX + marker.date);
      values = raw === null ? {} : JSON.parse(raw);
    } catch (_) { throw recoveryError(); }
    if (!values || typeof values !== "object" || Array.isArray(values)) throw recoveryError();
    const present = Object.hasOwn(values, marker.id);
    // An interrupted/failed local write must never turn metadata alone into a
    // deletion or replacement of the server's existing data.
    if ((marker.kind === "set") !== present
        || present && values[marker.id] !== marker.value) throw recoveryError();
    if (!isCurrent(marker)) continue;
    await sendMarker(marker, present ? { set: { [marker.id]: values[marker.id] }, del: [] } : { set: {}, del: [marker.id] });
  }
}
