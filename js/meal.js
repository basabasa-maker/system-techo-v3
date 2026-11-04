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

// 時刻は「時」「分」の2つの選択欄。分は15分刻み（それ以外の既存値は残す）
function timeSelectsHtml(slot, selected) {
  const m = String(selected || "").match(/^(\d{1,2}):(\d{2})/);
  const hh = m ? pad2(parseInt(m[1], 10)) : "";
  const mm = m ? m[2] : "";
  let hOpts = `<option value="">--</option>`;
  for (let h = 0; h < 24; h++) {
    const v = pad2(h);
    hOpts += `<option value="${v}" ${v === hh ? "selected" : ""}>${h}</option>`;
  }
  const mins = [];
  for (let x = 0; x < 60; x += MEAL_TIME_STEP_MIN) mins.push(pad2(x));
  if (mm && !mins.includes(mm)) mins.push(mm);
  mins.sort();
  let mOpts = `<option value="">--</option>`;
  for (const v of mins) mOpts += `<option value="${v}" ${v === mm ? "selected" : ""}>${v}</option>`;
  return `
    <span class="meal-time-wrap">
      <select class="meal-h" data-slot="${slot}" aria-label="${slot}の時">${hOpts}</select>
      <span class="meal-colon">時</span>
      <select class="meal-mi" data-slot="${slot}" aria-label="${slot}の分">${mOpts}</select>
      <span class="meal-colon">分</span>
    </span>`;
}

function paintDay() {
  const d = new Date(state.date + "T00:00:00");
  const w = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  const rows = MEAL_SLOTS.map(
    (s) => `
      <section class="meal-slot" data-slot="${s}">
        <div class="meal-slot-head">
          <h2>${s}</h2>
          ${timeSelectsHtml(s, state.slots[s].time)}
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
  rootEl.querySelectorAll(".meal-time-wrap").forEach((wrap) => {
    const hSel = wrap.querySelector(".meal-h");
    const mSel = wrap.querySelector(".meal-mi");
    const slot = hSel.dataset.slot;
    const update = (changed) => {
      // 時だけ選んだら分は00、時を「--」に戻したら全部消す
      if (changed === "h") {
        if (!hSel.value) mSel.value = "";
        else if (!mSel.value) mSel.value = "00";
      } else if (changed === "m" && mSel.value && !hSel.value) {
        hSel.value = pad2(new Date().getHours());
      }
      state.slots[slot].time = hSel.value && mSel.value ? `${hSel.value}:${mSel.value}` : "";
      onChanged();
    };
    hSel.addEventListener("change", () => update("h"));
    mSel.addEventListener("change", () => update("m"));
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
    // 送信待ちが送れなくても、取得は続ける
    await flushMealOutbox().catch(() => {});
    const days = await gas.pullMealMonth(key);
    // 取得した分は、月をすばやく切り替えた後でも必ず手元に保存する
    for (const ymd of Object.keys(days)) {
      saveDayLocal(ymd, normalizeSlots(days[ymd]));
    }
    // 画面は、まだその月を見ているときだけ描き直す
    if (state.view === "month" && monthKey() === key) paint();
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
