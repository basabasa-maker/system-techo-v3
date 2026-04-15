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
