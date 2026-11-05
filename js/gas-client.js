// gas-client.js - GAS Web API クライアント
// pullAll 禁止。push系は1件単位。

import { GAS_URL } from "./config.js";

async function fetchJson(url, options) {
  const res = await fetch(url, {
    mode: "cors",
    redirect: "follow",
    ...options,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error("Invalid JSON response (GAS access denied?)");
  }
}

// ---- Task ----

export async function pullTasks(sinceYmd) {
  const url = new URL(GAS_URL);
  url.searchParams.set("type", "tasks");
  if (sinceYmd) url.searchParams.set("since", sinceYmd);
  const body = await fetchJson(url.toString(), { method: "GET" });
  if (!body.ok) throw new Error(body.error || "pullTasks failed");
  return body.data.tasks || [];
}

export async function pushTaskUpsert(task) {
  const body = await fetchJson(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ type: "task_upsert", task: task }),
  });
  if (!body.ok) throw new Error(body.error || "task_upsert failed");
  return body.data;
}

export async function pushTaskDelete(id) {
  const body = await fetchJson(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ type: "task_delete", id: id }),
  });
  if (!body.ok) throw new Error(body.error || "task_delete failed");
  return body.data;
}

// ---- Calendar ----

export async function pullCalendar(dateYmd) {
  const url = new URL(GAS_URL);
  url.searchParams.set("type", "calendar");
  url.searchParams.set("date", dateYmd);
  const body = await fetchJson(url.toString(), { method: "GET" });
  if (!body.ok) throw new Error(body.error || "pullCalendar failed");
  return body.data.events || [];
}

// ---- Memo (Journal) ----

export async function pullMemoJournal(dateYmd) {
  const url = new URL(GAS_URL);
  url.searchParams.set("type", "memo_journal");
  url.searchParams.set("date", dateYmd);
  const body = await fetchJson(url.toString(), { method: "GET" });
  if (!body.ok) throw new Error(body.error || "pullMemoJournal failed");
  return body.data.entries || [];
}

export async function pushMemoUpsert(entry) {
  const body = await fetchJson(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ type: "memo_upsert", entry: entry }),
  });
  if (!body.ok) throw new Error(body.error || "memo_upsert failed");
  return body.data;
}

export async function pushMemoDelete(id) {
  const body = await fetchJson(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ type: "memo_delete", id: id }),
  });
  if (!body.ok) throw new Error(body.error || "memo_delete failed");
  return body.data;
}

// ---- Memo (Notes / Search / Day / UrlFetch / Inbox) ----

export async function pullMemoNotes(limit, offset) {
  const url = new URL(GAS_URL);
  url.searchParams.set("type", "memo_notes");
  if (limit != null) url.searchParams.set("limit", String(limit));
  if (offset != null) url.searchParams.set("offset", String(offset));
  const body = await fetchJson(url.toString(), { method: "GET" });
  if (!body.ok) throw new Error(body.error || "pullMemoNotes failed");
  return body.data || { entries: [], total: 0 };
}

export async function pullMemoSearch(q, entryType) {
  const url = new URL(GAS_URL);
  url.searchParams.set("type", "memo_search");
  url.searchParams.set("q", q || "");
  url.searchParams.set("entry_type", entryType || "all");
  const body = await fetchJson(url.toString(), { method: "GET" });
  if (!body.ok) throw new Error(body.error || "pullMemoSearch failed");
  return body.data || { entries: [], total: 0 };
}

export async function pullMemoAll(sinceYmd, limit) {
  const url = new URL(GAS_URL);
  url.searchParams.set("type", "memo_all");
  if (sinceYmd) url.searchParams.set("since", sinceYmd);
  if (limit != null) url.searchParams.set("limit", String(limit));
  const body = await fetchJson(url.toString(), { method: "GET" });
  if (!body.ok) throw new Error(body.error || "pullMemoAll failed");
  return body.data || { entries: [], total: 0 };
}

export async function pullMemoDay(dateYmd) {
  const url = new URL(GAS_URL);
  url.searchParams.set("type", "memo_day");
  url.searchParams.set("date", dateYmd);
  const body = await fetchJson(url.toString(), { method: "GET" });
  if (!body.ok) throw new Error(body.error || "pullMemoDay failed");
  return body.data.entries || [];
}

export async function fetchUrlTitle(url) {
  const body = await fetchJson(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ type: "memo_url_fetch", url: url }),
  });
  if (!body.ok) throw new Error(body.error || "memo_url_fetch failed");
  return body.data;
}

export async function pushMemoAttach(name, mime, b64) {
  const body = await fetchJson(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ type: "memo_attach", name, mime, data: b64 }),
  });
  if (!body.ok) throw new Error(body.error || "memo_attach failed");
  return body.data;
}

export async function pullMemoAttach(id) {
  const url = new URL(GAS_URL);
  url.searchParams.set("type", "memo_attach_get");
  url.searchParams.set("id", id);
  const body = await fetchJson(url.toString(), { method: "GET" });
  if (!body.ok) throw new Error(body.error || "memo_attach_get failed");
  return body.data;
}

export async function pushMemoInboxWrite(entryId, dateYmd) {
  const payload = { type: "memo_inbox_write" };
  if (entryId) payload.entry_id = entryId;
  if (dateYmd) payload.date = dateYmd;
  const body = await fetchJson(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
  });
  if (!body.ok) throw new Error(body.error || "memo_inbox_write failed");
  return body.data;
}

// ---- 習慣 ----
// 日付ごとに1件ずつ保存する。全件の取得・上書きはしない。

export async function pullHabitItems() {
  const url = new URL(GAS_URL);
  url.searchParams.set("type", "habit_items");
  const body = await fetchJson(url.toString(), { method: "GET" });
  if (!body.ok) throw new Error(body.error || "pullHabitItems failed");
  return body.data.items || null;
}

export async function pushHabitItems(items) {
  const body = await fetchJson(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ type: "habit_items_upsert", items: items }),
  });
  if (!body.ok) throw new Error(body.error || "habit_items_upsert failed");
  return body.data;
}

export async function pullHabitDay(dateYmd) {
  const url = new URL(GAS_URL);
  url.searchParams.set("type", "habit_day");
  url.searchParams.set("date", dateYmd);
  const body = await fetchJson(url.toString(), { method: "GET" });
  if (!body.ok) throw new Error(body.error || "pullHabitDay failed");
  return body.data.values || null;
}

export async function pullHabitRange(fromYmd, toYmd) {
  const url = new URL(GAS_URL);
  url.searchParams.set("type", "habit_range");
  url.searchParams.set("from", fromYmd);
  url.searchParams.set("to", toYmd);
  const body = await fetchJson(url.toString(), { method: "GET" });
  if (!body.ok) throw new Error(body.error || "pullHabitRange failed");
  return body.data.days || {};
}

// patch = { set: {項目ID: 値}, del: [項目ID] }（変えた項目だけ送る）
export async function pushHabitDay(dateYmd, patch) {
  const body = await fetchJson(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      type: "habit_day_upsert",
      date: dateYmd,
      set: (patch && patch.set) || {},
      del: (patch && patch.del) || [],
    }),
  });
  if (!body.ok) throw new Error(body.error || "habit_day_upsert failed");
  return body.data;
}

// ---- 食事 ----

export async function pullMealMonth(monthYm) {
  const url = new URL(GAS_URL);
  url.searchParams.set("type", "meal_month");
  url.searchParams.set("month", monthYm);
  const body = await fetchJson(url.toString(), { method: "GET" });
  if (!body.ok) throw new Error(body.error || "pullMealMonth failed");
  return body.data.days || {};
}

// set = { 区分: {time, text} }（変えた区分だけ送る）
export async function pushMealDay(dateYmd, set) {
  const body = await fetchJson(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      type: "meal_day_upsert",
      date: dateYmd,
      set: set,
    }),
  });
  if (!body.ok) throw new Error(body.error || "meal_day_upsert failed");
  return body.data;
}
