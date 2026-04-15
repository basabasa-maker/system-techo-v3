// store.js - localStorage ベースの表示キャッシュ
// Sheets が正。localStorage は UI の即時表示用。

import { LS_KEY_TASKS } from "./config.js";

export function loadTasks() {
  try {
    const raw = localStorage.getItem(LS_KEY_TASKS);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
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
