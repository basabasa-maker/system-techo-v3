// habit.js - 習慣タブ（旧アプリ「習慣ログ」を手帳に統合）
// - 日付ごとに 時刻・数値・チェック を記録する（メモ欄は無し）
// - 各項目は長押しで上下に移動できる（reorder.js）
// - 保存は日付1件ずつ。全件の取得・上書きはしない
// - 旧アプリの過去データは取り込まない（白紙から開始）

import * as gas from "./gas-client.js";
import * as outbox from "./outbox.js";
import {
  HABIT_DEFAULT_ITEMS,
  LS_KEY_HABIT_DAY_PREFIX,
  LS_KEY_HABIT_ITEMS,
} from "./config.js";
import { toast, showSpinner, hideSpinner } from "./toast.js";
import { todayYmd, addDaysYmd, parseYmd, pad2 } from "./date-util.js";
import { enableLongPressReorder, justDragged } from "./reorder.js";
import { loadRange, renderCharts, renderHistory } from "./habit-stats.js";

const state = {
  date: todayYmd(),
  items: [],
  values: {},
  editMode: false,
  sub: "input", // input | chart | hist
};

let rootEl = null;
let pushTimer = null;

// ---------- 保存（表示キャッシュ） ----------

// 旧い保存データの種類を、いまの種類へそろえる（フォロワー等は累積）
// 初期設定の入力ルール。保存済みの項目にも、ここで決めたルールをそのまま当てる
const RULE_BY_ID = {
  nap: "integer",
  weight: "decimal",
  bodyFat: "decimal",
  kcal: "integer",
  steps: "integer",
  water: "integer",
  tabelogFollowers: "cumulative",
  tabelogReactions: "cumulative",
  instaFollowers: "cumulative",
};
function normalizeItems(arr) {
  return arr.map((it) => {
    const rule = RULE_BY_ID[it.id];
    // 古い保存データの「数値」だけを、初期ルールに置き換える（自分で変えた種類は残す）
    return rule && it.type === "number" ? { ...it, type: rule } : it;
  });
}

function loadItems() {
  try {
    const raw = localStorage.getItem(LS_KEY_HABIT_ITEMS);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) return normalizeItems(arr);
    }
  } catch (e) {
    /* 壊れていたら初期項目に戻す */
  }
  return JSON.parse(JSON.stringify(HABIT_DEFAULT_ITEMS));
}

function saveItemsLocal(items) {
  localStorage.setItem(LS_KEY_HABIT_ITEMS, JSON.stringify(items));
}

function loadDay(ymd) {
  try {
    const raw = localStorage.getItem(LS_KEY_HABIT_DAY_PREFIX + ymd);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch (e) {
    return {};
  }
}

function saveDayLocal(ymd, values) {
  localStorage.setItem(LS_KEY_HABIT_DAY_PREFIX + ymd, JSON.stringify(values));
}

// ---------- 描画 ----------

export function renderHabitTab(container) {
  rootEl = container;
  state.items = loadItems();
  state.values = loadDay(state.date);
  paint();
  syncFromServer();
}

function dateTitle(ymd) {
  const d = parseYmd(ymd);
  if (!d) return ymd;
  const w = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日（${w}）`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 就寝〜起床の睡眠時間（分）。就寝が起床より後なら日またぎとみなす
function sleepMinutes(values) {
  const a = toMin(values.sleepStart);
  const b = toMin(values.sleepEnd);
  if (a == null || b == null) return null;
  let diff = b - a;
  if (diff < 0) diff += 24 * 60;
  return diff;
}

function toMin(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function sleepLabel(values) {
  const min = sleepMinutes(values);
  if (min == null) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}時間` : `${h}時間${m}分`;
}

function valueLabel(item, v) {
  if (v == null || v === "") return "";
  if (item.type === "time") return String(v);
  return item.unit ? `${v}<span class="habit-unit">${escapeHtml(item.unit)}</span>` : String(v);
}

function itemHtml(item) {
  const v = state.values[item.id];
  const icon = `<span class="habit-icon">${escapeHtml(item.icon || "•")}</span>`;
  const del = state.editMode
    ? `<button class="habit-del" data-del="${escapeHtml(item.id)}" aria-label="削除">−</button>`
    : "";
  if (item.type === "check") {
    const on = v === true;
    return `
      <li class="habit-item habit-check-row" data-id="${escapeHtml(item.id)}">
        ${del}
        <button class="habit-check ${on ? "on" : ""}" aria-label="チェック">${on ? "✓" : ""}</button>
        ${icon}
        <span class="habit-label">${escapeHtml(item.label)}</span>
      </li>`;
  }
  const filled = v != null && v !== "";
  const isCum = item.type === "cumulative";
  const isInt = item.type === "integer" || isCum;
  const input =
    item.type === "time"
      ? `<input type="time" class="habit-value habit-value-input ${filled ? "filled" : ""}" value="${escapeHtml(toHhMm(v))}" />`
      : `<input type="number" inputmode="${isInt ? "numeric" : "decimal"}" step="${isInt ? "1" : "any"}" placeholder="${isCum ? "＋加算" : "入力"}" class="habit-value habit-value-input ${isCum ? "" : filled ? "filled" : ""}" value="${isCum ? "" : filled ? escapeHtml(v) : ""}" />`;
  // 単位欄は空でも幅を確保し、入力欄の左右位置を全項目でそろえる
  const unit = `<span class="habit-unit-out">${item.type !== "time" && item.unit ? escapeHtml(item.unit) : ""}</span>`;
  // 累積の項目：欄に入れた数が、そのまま合計に足される。合計は項目名の下に出す
  const tail = `<button class="habit-clear" aria-label="${isCum ? "合計を0に戻す" : "消す"}" ${filled ? "" : "hidden"}>×</button>`;
  const total = isCum
    ? `<small class="habit-total">合計 ${filled ? escapeHtml(v) : 0}${escapeHtml(item.unit || "")}</small>`
    : "";
  return `
    <li class="habit-item" data-id="${escapeHtml(item.id)}">
      ${del}
      ${icon}
      <span class="habit-label">${escapeHtml(item.label)}${total}</span>
      ${input}${unit}
      ${tail}
    </li>`;
}

function subTabsHtml() {
  const t = (id, label) => `<button class="habit-sub ${state.sub === id ? "on" : ""}" data-sub="${id}">${label}</button>`;
  return `<div class="habit-subtabs">${t("input", "入力")}${t("chart", "グラフ")}${t("hist", "履歴")}</div>`;
}

function bindSubTabs() {
  rootEl.querySelectorAll(".habit-sub").forEach((b) => {
    b.addEventListener("click", () => {
      state.sub = b.dataset.sub;
      state.editMode = false;
      paint();
    });
  });
}

async function paintStats() {
  rootEl.innerHTML = `<div class="habit-tab">${subTabsHtml()}<div id="habit-stats" class="habit-stats"><p class="empty-hint">読み込み中…</p></div></div>`;
  bindSubTabs();
  const sub = state.sub;
  const data = await loadRange();
  const box = rootEl && rootEl.querySelector("#habit-stats");
  if (!box || state.sub !== sub) return;
  if (sub === "chart") renderCharts(box, state.items, data);
  else {
    renderHistory(box, state.items, data, (ymd) => {
      state.date = ymd;
      state.sub = "input";
      state.values = loadDay(ymd);
      paint();
      syncFromServer();
    });
  }
}

function paint() {
  if (!rootEl) return;
  if (state.sub !== "input") {
    paintStats();
    return;
  }
  rootEl.innerHTML = `
    <div class="habit-tab">
      ${subTabsHtml()}
      <div class="habit-nav">
        <button id="h-prev" class="habit-nav-btn" aria-label="前の日">‹</button>
        <div class="habit-date">${dateTitle(state.date)}</div>
        <button id="h-next" class="habit-nav-btn" aria-label="次の日">›</button>
        <button id="h-today" class="habit-today">今日</button>
        <button id="h-edit" class="habit-edit-btn">${state.editMode ? "完了" : "編集"}</button>
      </div>
      <section class="habit-card">
        <h2>睡眠</h2>
        <div class="habit-sleep">
          <span class="habit-icon">🌙</span>
          <span class="habit-label">睡眠時間</span>
          <span class="habit-sleep-val">${sleepLabel(state.values)}</span>
        </div>
      </section>
      <section class="habit-card">
        <h2>項目</h2>
        <ul id="habit-list" class="habit-list ${state.editMode ? "editing" : ""}">
          ${state.items.map(itemHtml).join("")}
        </ul>
        <button id="h-add" class="habit-add">＋ 項目を追加</button>
        <p class="habit-hint">項目を長押しすると、上下に動かせます。</p>
      </section>
    </div>`;
  bind();
}

function bind() {
  bindSubTabs();
  rootEl.querySelector("#h-prev").addEventListener("click", () => moveDate(-1));
  rootEl.querySelector("#h-next").addEventListener("click", () => moveDate(1));
  rootEl.querySelector("#h-today").addEventListener("click", () => {
    state.date = todayYmd();
    reloadDay();
  });
  rootEl.querySelector("#h-edit").addEventListener("click", () => {
    state.editMode = !state.editMode;
    paint();
  });
  rootEl.querySelector("#h-add").addEventListener("click", () => openItemEditor(null));

  const listEl = rootEl.querySelector("#habit-list");
  listEl.querySelectorAll(".habit-item").forEach((li) => {
    const id = li.dataset.id;
    const item = state.items.find((x) => x.id === id);
    if (!item) return;
    const del = li.querySelector(".habit-del");
    if (del) {
      del.addEventListener("click", () => deleteItem(id));
    }
    if (item.type === "check") {
      li.addEventListener("click", (e) => {
        if (justDragged() || e.target.closest(".habit-del")) return;
        toggleCheck(id);
      });
    } else {
      const inp = li.querySelector(".habit-value-input");
      const clr = li.querySelector(".habit-clear");
      const commit = () => {
        const raw = inp.value;
        if (item.type === "cumulative") {
          // 入れた数を、いまの合計に足す（マイナスで引くことも可）
          inp.value = "";
          const n = Math.round(Number(raw));
          if (raw === "" || !Number.isFinite(n) || n === 0) return;
          setValue(id, (Number(state.values[id]) || 0) + n);
          return;
        }
        let val = "";
        if (item.type === "time") val = raw ? toHhMm(raw) : "";
        else if (raw !== "") {
          let n = Number(raw);
          if (!Number.isFinite(n)) return;
          if (item.type === "integer" || item.type === "cumulative") n = Math.round(n);
          val = n;
        }
        const cur = state.values[id];
        if ((cur == null ? "" : cur) === val) return;
        setValue(id, val, true);
        inp.classList.toggle("filled", val !== "");
        if (clr) clr.hidden = val === "";
      };
      inp.addEventListener("change", commit);
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") inp.blur();
      });
      clr.addEventListener("click", () => {
        if (item.type === "cumulative") {
          if (!confirm(`「${item.label}」の合計を消しますか？`)) return;
          setValue(id, "");
          return;
        }
        inp.value = "";
        commit();
      });
    }
    if (state.editMode) {
      li.querySelector(".habit-label").addEventListener("click", (e) => {
        e.stopPropagation();
        openItemEditor(id);
      });
      li.querySelector(".habit-icon").addEventListener("click", (e) => {
        e.stopPropagation();
        openItemEditor(id);
      });
    }
  });

  enableLongPressReorder(listEl, {
    itemSelector: ".habit-item",
    onReorder: onReorderItems,
    ignoreSelector: ".habit-value-input, .habit-clear",
  });
}

// ---------- 日付の移動 ----------

function moveDate(diff) {
  state.date = addDaysYmd(state.date, diff);
  reloadDay();
}

function reloadDay() {
  state.values = loadDay(state.date);
  paint();
  syncFromServer();
}

// ---------- 値の更新 ----------

function setValue(id, value, quiet) {
  const next = { ...state.values };
  if (value === "" || value == null || value === false) delete next[id];
  else next[id] = value;
  state.values = next;
  saveDayLocal(state.date, next);
  if (quiet) {
    // 入力中の欄を作り直さない。睡眠時間だけ更新する
    const el = rootEl && rootEl.querySelector(".habit-sleep-val");
    if (el) el.textContent = sleepLabel(next);
  } else {
    paint();
  }
  schedulePush(state.date, next);
}

function toggleCheck(id) {
  setValue(id, state.values[id] === true ? false : true);
}

function schedulePush(ymd, values) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushDay(ymd, values), 600);
}

async function pushDay(ymd, values) {
  try {
    await gas.pushHabitDay(ymd, values);
  } catch (e) {
    await outbox.enqueue({
      type: "habit_day_upsert",
      payload: { date: ymd, values: values },
    });
    toast("オフライン：送信キューに追加", "warn");
  }
}

async function pushItems(items) {
  try {
    await gas.pushHabitItems(items);
  } catch (e) {
    await outbox.enqueue({ type: "habit_items_upsert", payload: { items } });
    toast("オフライン：送信キューに追加", "warn");
  }
}

// ---------- 項目の並べ替え・追加・削除 ----------

function onReorderItems(ids) {
  const byId = new Map(state.items.map((x) => [x.id, x]));
  const next = ids.map((id) => byId.get(id)).filter(Boolean);
  if (next.length !== state.items.length) return paint();
  state.items = next;
  saveItemsLocal(next);
  paint();
  pushItems(next);
}

function deleteItem(id) {
  const item = state.items.find((x) => x.id === id);
  if (!item) return;
  if (!confirm(`「${item.label}」を項目から外しますか？\n記録済みの値は残ります。`)) return;
  state.items = state.items.filter((x) => x.id !== id);
  saveItemsLocal(state.items);
  paint();
  pushItems(state.items);
}

const ICONS = ["🌙","☀️","💤","⏰","🍽️","💧","⚖️","📏","🔥","👣","📱","📊","📈","📉","🎯","✅","🧘","📋","📧","📅","🤸","💊","🏠","💝","🏃","🚶","🧠","💪","❤️","🩺","🌡️","💉","🍎","🥗","🍺","☕","📖","🎵","🎮","💰","🛒","📝","⭐","🔔","🕐","📸","🎨","🗂️","🌿","🎓"];

// 項目の追加・編集（アイコン・名前・入力方式・単位）
function openItemEditor(id) {
  const item = id ? state.items.find((x) => x.id === id) : null;
  if (id && !item) return;
  let icon = item ? item.icon || "•" : ICONS[0];
  const type = item ? (item.type === "number" ? "decimal" : item.type) : "integer";
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <header>${item ? "項目を編集" : "項目を追加"}</header>
      <div class="modal-body">
        <div class="ed-label">アイコン</div>
        <div class="icon-grid">${ICONS.map((ic) => `<button type="button" class="icon-opt ${ic === icon ? "sel" : ""}" data-ic="${ic}">${ic}</button>`).join("")}</div>
        <label>項目名
          <input type="text" id="e-label" autocomplete="off" placeholder="例：体温" value="${escapeHtml(item ? item.label : "")}" />
        </label>
        <label>入力方式
          <select id="e-type">
            <option value="integer">整数（0, 1, 2 …）</option>
            <option value="decimal">小数（体重など）</option>
            <option value="cumulative">累積（欄に入れた数を合計に足す）</option>
            <option value="check">チェック</option>
            <option value="time">時刻</option>
          </select>
        </label>
        <label id="e-unit-wrap">単位（例：kg、歩、ml）
          <input type="text" id="e-unit" autocomplete="off" value="${escapeHtml(item ? item.unit || "" : "")}" />
        </label>
      </div>
      <footer>
        <div style="flex:1"></div>
        <button class="btn-ghost" id="e-cancel">キャンセル</button>
        <button class="btn-primary" id="e-save">${item ? "保存" : "追加"}</button>
      </footer>
    </div>`;
  document.body.appendChild(modal);
  const typeSel = modal.querySelector("#e-type");
  typeSel.value = type;
  const syncUnit = () => {
    modal.querySelector("#e-unit-wrap").style.display =
      typeSel.value === "check" || typeSel.value === "time" ? "none" : "";
  };
  typeSel.addEventListener("change", syncUnit);
  syncUnit();
  modal.querySelectorAll(".icon-opt").forEach((b) => {
    b.addEventListener("click", () => {
      modal.querySelectorAll(".icon-opt").forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
      icon = b.dataset.ic;
    });
  });
  const close = () => modal.remove();
  modal.querySelector("#e-cancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  modal.querySelector("#e-save").addEventListener("click", () => {
    const label = modal.querySelector("#e-label").value.trim();
    if (!label) {
      toast("項目名を入力してください", "error");
      return;
    }
    const t = typeSel.value;
    const unit = t === "check" || t === "time" ? "" : modal.querySelector("#e-unit").value.trim();
    const next = { id: item ? item.id : "c_" + Date.now(), label, icon, type: t, unit };
    state.items = item
      ? state.items.map((x) => (x.id === item.id ? next : x))
      : [...state.items, next];
    saveItemsLocal(state.items);
    close();
    paint();
    pushItems(state.items);
  });
  if (!item) setTimeout(() => modal.querySelector("#e-label").focus(), 50);
}

// ---------- 値の入力モーダル ----------

function openValueModal(item) {
  const cur = state.values[item.id];
  const isTime = item.type === "time";
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <header>${escapeHtml(item.label)}</header>
      <div class="modal-body">
        ${
          isTime
            ? `<input type="time" id="v-input" value="${escapeHtml(toHhMm(cur))}" />`
            : `<label>${item.unit ? "単位: " + escapeHtml(item.unit) : "数値"}
                 <input type="number" id="v-input" inputmode="decimal" step="any" value="${cur != null ? escapeHtml(cur) : ""}" />
               </label>`
        }
      </div>
      <footer>
        <button class="btn-danger" id="v-clear">消す</button>
        <div style="flex:1"></div>
        <button class="btn-ghost" id="v-cancel">キャンセル</button>
        <button class="btn-primary" id="v-save">保存</button>
      </footer>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector("#v-cancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  modal.querySelector("#v-clear").addEventListener("click", () => {
    close();
    setValue(item.id, "");
  });
  modal.querySelector("#v-save").addEventListener("click", () => {
    const raw = modal.querySelector("#v-input").value;
    close();
    if (isTime) {
      setValue(item.id, raw ? toHhMm(raw) : "");
    } else {
      const n = raw === "" ? "" : Number(raw);
      if (n !== "" && !Number.isFinite(n)) {
        toast("数値を入力してください", "error");
        return;
      }
      setValue(item.id, n);
    }
  });
  setTimeout(() => modal.querySelector("#v-input").focus(), 50);
}

// "2:00" / "02:00" → "02:00"
function toHhMm(v) {
  const m = String(v || "").match(/^(\d{1,2}):(\d{2})/);
  return m ? `${pad2(parseInt(m[1], 10))}:${m[2]}` : "";
}

// ---------- 同期 ----------

let syncSeq = 0;

async function syncFromServer() {
  const seq = ++syncSeq;
  const ymd = state.date;
  try {
    // 送信待ちが送れなくても、取得は続ける
    await flushHabitOutbox().catch(() => {});
    const [items, values] = await Promise.all([
      gas.pullHabitItems(),
      gas.pullHabitDay(ymd),
    ]);
    if (seq !== syncSeq || !rootEl) return;
    let changed = false;
    if (Array.isArray(items) && items.length > 0) {
      state.items = normalizeItems(items);
      saveItemsLocal(state.items);
      changed = true;
    }
    if (values && typeof values === "object") {
      state.values = values;
      saveDayLocal(ymd, values);
      changed = true;
    }
    if (changed && !document.querySelector(".modal-backdrop")) paint();
  } catch (e) {
    // オフラインや未デプロイ時は、手元のキャッシュ表示のまま使い続ける
    console.warn("habit sync skipped:", e.message);
  }
}

export async function flushHabitOutbox() {
  const items = await outbox.listAll();
  for (const it of items) {
    const t = it.op.type;
    if (t === "habit_day_upsert") {
      await gas.pushHabitDay(it.op.payload.date, it.op.payload.values);
    } else if (t === "habit_items_upsert") {
      await gas.pushHabitItems(it.op.payload.items);
    } else {
      continue;
    }
    await outbox.remove(it.id);
  }
}

// 更新ボタンから呼ばれる
export async function pullAndRender() {
  showSpinner();
  try {
    await flushHabitOutbox();
    const [items, values] = await Promise.all([
      gas.pullHabitItems(),
      gas.pullHabitDay(state.date),
    ]);
    if (Array.isArray(items) && items.length > 0) {
      state.items = normalizeItems(items);
      saveItemsLocal(state.items);
    }
    if (values && typeof values === "object") {
      state.values = values;
      saveDayLocal(state.date, values);
    }
    paint();
    toast("最新化しました", "success");
  } catch (e) {
    console.error(e);
    toast("取得に失敗しました: " + e.message, "error");
  } finally {
    hideSpinner();
  }
}
