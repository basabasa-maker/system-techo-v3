// store.js - localStorage ベースの表示キャッシュ
// Sheets が正。localStorage は UI の即時表示用。

import {
  LS_KEY_TASKS,
  LS_KEY_CACHE_SCHEMA,
  LS_KEY_CAL_PREFIX,
  LS_KEY_JOURNAL_PREFIX,
  LS_KEY_MEMO_DAY_PREFIX,
  LS_KEY_MEMO_NOTES,
  CACHE_SCHEMA_VERSION,
} from "./config.js";

// 起動時にキャッシュスキーマをチェックし、旧バージョンなら破棄する
// （Sprint 1で Date.toString 形式の旧キャッシュが残ると表示崩壊するため）
function ensureCacheSchema() {
  const stored = localStorage.getItem(LS_KEY_CACHE_SCHEMA);
  if (stored !== String(CACHE_SCHEMA_VERSION)) {
    localStorage.removeItem(LS_KEY_TASKS);
    localStorage.setItem(LS_KEY_CACHE_SCHEMA, String(CACHE_SCHEMA_VERSION));
  }
}
ensureCacheSchema();

// 日時フィールドがYYYY-MM-DD/YYYY-MM-DD HH:mm形式でない場合は空文字に正規化
function sanitizeTask(t) {
  if (!t || typeof t !== "object") return t;
  const dueOk = /^\d{4}-\d{2}-\d{2}$/.test(t.due_date || "");
  const cAt = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(t.created_at || "");
  const uAt = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(t.updated_at || "");
  return {
    ...t,
    due_date: dueOk ? t.due_date : "",
    created_at: cAt ? t.created_at : "",
    updated_at: uAt ? t.updated_at : "",
  };
}

export function loadTasks() {
  try {
    const raw = localStorage.getItem(LS_KEY_TASKS);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(sanitizeTask) : [];
  } catch (e) {
    return [];
  }
}

export function saveTasks(tasks) {
  localStorage.setItem(LS_KEY_TASKS, JSON.stringify(tasks));
}

// サーバからの差分を既存キャッシュにマージ。
// 同一 id は updated_at が新しい方を採用、deleted=1 はキャッシュから除去。
export function mergeTasks(serverTasks) {
  const current = loadTasks();
  const byId = new Map();
  for (const t of current) byId.set(t.id, t);
  for (const st of serverTasks) {
    if (st.deleted) {
      byId.delete(st.id);
      continue;
    }
    const cur = byId.get(st.id);
    if (!cur || (st.updated_at || "") >= (cur.updated_at || "")) {
      byId.set(st.id, st);
    }
  }
  const merged = Array.from(byId.values()).filter((t) => !t.deleted);
  saveTasks(merged);
  return merged;
}

// ローカル書込（push前に即時反映）
export function upsertLocal(task) {
  const list = loadTasks();
  const idx = list.findIndex((t) => t.id === task.id);
  if (idx >= 0) list[idx] = task;
  else list.push(task);
  saveTasks(list);
}

export function deleteLocal(id) {
  const list = loadTasks().filter((t) => t.id !== id);
  saveTasks(list);
}

// ---------- Daily (calendar events / journal entries) ----------
// 日付ごとに小さなJSONとしてキャッシュ。取得はその日のタブ表示直後に1度、
// 更新ボタン押下でも再取得して上書きする。

export function loadCalendar(dateYmd) {
  try {
    const raw = localStorage.getItem(LS_KEY_CAL_PREFIX + dateYmd);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

export function saveCalendar(dateYmd, events) {
  localStorage.setItem(
    LS_KEY_CAL_PREFIX + dateYmd,
    JSON.stringify(Array.isArray(events) ? events : []),
  );
}

export function loadJournal(dateYmd) {
  try {
    const raw = localStorage.getItem(LS_KEY_JOURNAL_PREFIX + dateYmd);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

export function saveJournal(dateYmd, entries) {
  localStorage.setItem(
    LS_KEY_JOURNAL_PREFIX + dateYmd,
    JSON.stringify(Array.isArray(entries) ? entries : []),
  );
}

export function upsertJournalLocal(dateYmd, entry) {
  const list = loadJournal(dateYmd);
  const idx = list.findIndex((e) => e.id === entry.id);
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  saveJournal(dateYmd, list);
  return list;
}

// ---------- Memo tab cache ----------

export function loadMemoDay(dateYmd) {
  try {
    const raw = localStorage.getItem(LS_KEY_MEMO_DAY_PREFIX + dateYmd);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

export function saveMemoDay(dateYmd, entries) {
  localStorage.setItem(
    LS_KEY_MEMO_DAY_PREFIX + dateYmd,
    JSON.stringify(Array.isArray(entries) ? entries : []),
  );
}

export function upsertMemoDayLocal(dateYmd, entry) {
  const list = loadMemoDay(dateYmd);
  const idx = list.findIndex((e) => e.id === entry.id);
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  saveMemoDay(dateYmd, list);
  return list;
}

export function deleteMemoDayLocal(dateYmd, id) {
  const list = loadMemoDay(dateYmd).filter((e) => e.id !== id);
  saveMemoDay(dateYmd, list);
  return list;
}

export function loadMemoNotes() {
  try {
    const raw = localStorage.getItem(LS_KEY_MEMO_NOTES);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

export function saveMemoNotes(entries) {
  localStorage.setItem(
    LS_KEY_MEMO_NOTES,
    JSON.stringify(Array.isArray(entries) ? entries : []),
  );
}
