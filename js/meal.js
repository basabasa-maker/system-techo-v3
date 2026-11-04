// meal.js - 食事タブ（Memoとは別。食事専用の記録）
// - 月のカレンダー。記録がある日には点が付く
// - 日付を押すと「朝・昼・夕・間食・夜食」の欄が開く
// - 各欄に、食べたものと時刻（15分刻みのプルダウン）を書ける
// - 保存は日付1件ずつ

import * as gas from "./gas-client.js";
import * as outbox from "./outbox.js";
import {
  MEAL_SLOTS,
  MEAL_TIME_STEP_MIN,
  LS_KEY_MEAL_DAY_PREFIX,
} from "./config.js";
import { toast, showSpinner, hideSpinner } from "./toast.js";
import { todayYmd, pad2 } from "./date-util.js";

const state = {
  view: "month", // month | day
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1, // 1-12
  date: null,
  slots: null,
};

let rootEl = null;
let pushTimer = null;

// ---------- 表示キャッシュ ----------

function emptySlots() {
  const o = {};
  for (const s of MEAL_SLOTS) o[s] = { time: "", text: "" };
  return o;
}

function normalizeSlots(raw) {
  const out = emptySlots();
  if (raw && typeof raw === "object") {
    for (const s of MEAL_SLOTS) {
      const v = raw[s];
      if (v && typeof v === "object") {
        out[s] = { time: String(v.time || ""), text: String(v.text || "") };
      }
    }
  }
  return out;
}

function hasContent(slots) {
  return MEAL_SLOTS.some((s) => slots[s].text.trim() || slots[s].time);
}

function loadDay(ymd) {
  try {
    const raw = localStorage.getItem(LS_KEY_MEAL_DAY_PREFIX + ymd);
    return normalizeSlots(raw ? JSON.parse(raw) : null);
  } catch (e) {
    return emptySlots();
  }
}

function saveDayLocal(ymd, slots) {
  localStorage.setItem(LS_KEY_MEAL_DAY_PREFIX + ymd, JSON.stringify(slots));
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------- 入口 ----------

export function renderMealTab(container) {
  rootEl = container;
  paint();
  if (state.view === "month") syncMonth();
}

function paint() {
  if (!rootEl) return;
  if (state.view === "day") paintDay();
  else paintMonth();
}

// ---------- 月カレンダー ----------

function monthKey() {
  return `${state.year}-${pad2(state.month)}`;
}

function paintMonth() {
  const first = new Date(state.year, state.month - 1, 1);
  const lastDay = new Date(state.year, state.month, 0).getDate();
  const startWeekday = first.getDay();
  const today = todayYmd();
  const heads = ["日", "月", "火", "水", "木", "金", "土"]
    .map((w) => `<div class="meal-wd">${w}</div>`)
    .join("");
  let cells = "";
  for (let i = 0; i < startWeekday; i++) cells += `<div class="meal-cell blank"></div>`;
  for (let d = 1; d <= lastDay; d++) {
    const ymd = `${state.year}-${pad2(state.month)}-${pad2(d)}`;
    const has = hasContent(loadDay(ymd));
    cells += `
      <button class="meal-cell ${ymd === today ? "today" : ""}" data-date="${ymd}">
        <span class="meal-day">${d}</span>
        ${has ? `<span class="meal-dot"></span>` : ""}
      </button>`;
  }
  rootEl.innerHTML = `
    <div class="meal-tab">
      <div class="habit-nav">
        <button id="m-prev" class="habit-nav-btn" aria-label="前の月">‹</button>
        <div class="habit-date">${state.year}年${state.month}月</div>
        <button id="m-next" class="habit-nav-btn" aria-label="次の月">›</button>
        <button id="m-today" class="habit-today">今日</button>
      </div>
      <div class="meal-grid">${heads}${cells}</div>
      <p class="habit-hint">日付を押すと、その日の食事を記録できます。</p>
    </div>`;
  rootEl.querySelector("#m-prev").addEventListener("click", () => moveMonth(-1));
  rootEl.querySelector("#m-next").addEventListener("click", () => moveMonth(1));
  rootEl.querySelector("#m-today").addEventListener("click", () => {
    const d = new Date();
    state.year = d.getFullYear();
    state.month = d.getMonth() + 1;
    paint();
    syncMonth();
  });
  rootEl.querySelectorAll(".meal-cell[data-date]").forEach((b) => {
    b.addEventListener("click", () => openDay(b.dataset.date));
  });
}

function moveMonth(diff) {
  const d = new Date(state.year, state.month - 1 + diff, 1);
  state.year = d.getFullYear();
  state.month = d.getMonth() + 1;
  paint();
  syncMonth();
}

// ---------- 日ごとの入力 ----------

function openDay(ymd) {
  state.view = "day";
  state.date = ymd;
  state.slots = loadDay(ymd);
  paint();
}

function timeOptions(selected) {
  let html = `<option value="">時刻</option>`;
  for (let m = 0; m < 24 * 60; m += MEAL_TIME_STEP_MIN) {
    const v = `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
    html += `<option value="${v}" ${v === selected ? "selected" : ""}>${v}</option>`;
  }
  // 15分刻み以外の値が入っていた場合も消さずに選択肢へ足す
  if (selected && !html.includes(`value="${selected}"`)) {
    html += `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}</option>`;
  }
  return html;
}

function paintDay() {
  const d = new Date(state.date + "T00:00:00");
  const w = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  const rows = MEAL_SLOTS.map(
    (s) => `
      <section class="meal-slot" data-slot="${s}">
        <div class="meal-slot-head">
          <h2>${s}</h2>
          <select class="meal-time" data-slot="${s}" aria-label="${s}の時刻">
            ${timeOptions(state.slots[s].time)}
          </select>
        </div>
        <textarea class="meal-text" data-slot="${s}" rows="2" placeholder="食べたものをメモ">${escapeHtml(state.slots[s].text)}</textarea>
      </section>`,
  ).join("");
  rootEl.innerHTML = `
    <div class="meal-tab">
      <div class="habit-nav">
        <button id="m-back" class="habit-nav-btn" aria-label="カレンダーに戻る">‹</button>
        <div class="habit-date">${d.getMonth() + 1}月${d.getDate()}日（${w}）</div>
        <span class="habit-nav-spacer"></span>
      </div>
      ${rows}
    </div>`;
  rootEl.querySelector("#m-back").addEventListener("click", () => {
    flushPendingPush();
    state.view = "month";
    state.year = d.getFullYear();
    state.month = d.getMonth() + 1;
    paint();
    syncMonth();
  });
  rootEl.querySelectorAll(".meal-time").forEach((sel) => {
    sel.addEventListener("change", () => {
      state.slots[sel.dataset.slot].time = sel.value;
      onChanged();
    });
  });
  rootEl.querySelectorAll(".meal-text").forEach((ta) => {
    ta.addEventListener("input", () => {
      state.slots[ta.dataset.slot].text = ta.value;
      onChanged();
    });
  });
}

// ---------- 保存 ----------

function onChanged() {
  saveDayLocal(state.date, state.slots);
  clearTimeout(pushTimer);
  const ymd = state.date;
  const slots = JSON.parse(JSON.stringify(state.slots));
  pendingPush = { ymd, slots };
  pushTimer = setTimeout(flushPendingPush, 800);
}

let pendingPush = null;

function flushPendingPush() {
  clearTimeout(pushTimer);
  if (!pendingPush) return;
  const { ymd, slots } = pendingPush;
  pendingPush = null;
  pushDay(ymd, slots);
}

async function pushDay(ymd, slots) {
  try {
    await gas.pushMealDay(ymd, slots);
  } catch (e) {
    await outbox.enqueue({
      type: "meal_day_upsert",
      payload: { date: ymd, slots: slots },
    });
    toast("オフライン：送信キューに追加", "warn");
  }
}

// ---------- 同期 ----------

async function syncMonth() {
  const key = monthKey();
  try {
    await flushMealOutbox();
    const days = await gas.pullMealMonth(key);
    if (state.view !== "month" || monthKey() !== key) return;
    for (const ymd of Object.keys(days)) {
      saveDayLocal(ymd, normalizeSlots(days[ymd]));
    }
    paint();
  } catch (e) {
    // オフラインや未デプロイ時は、手元のキャッシュ表示のまま使い続ける
    console.warn("meal sync skipped:", e.message);
  }
}

export async function flushMealOutbox() {
  const items = await outbox.listAll();
  for (const it of items) {
    if (it.op.type === "meal_day_upsert") {
      await gas.pushMealDay(it.op.payload.date, it.op.payload.slots);
      await outbox.remove(it.id);
    }
  }
}

// 更新ボタンから呼ばれる
export async function pullAndRender() {
  showSpinner();
  try {
    flushPendingPush();
    await flushMealOutbox();
    const days = await gas.pullMealMonth(monthKey());
    for (const ymd of Object.keys(days)) {
      saveDayLocal(ymd, normalizeSlots(days[ymd]));
    }
    if (state.view === "day") state.slots = loadDay(state.date);
    paint();
    toast("最新化しました", "success");
  } catch (e) {
    console.error(e);
    toast("取得に失敗しました: " + e.message, "error");
  } finally {
    hideSpinner();
  }
}
