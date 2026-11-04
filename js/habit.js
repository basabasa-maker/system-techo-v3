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

const state = {
  date: todayYmd(),
  items: [],
  values: {},
  editMode: false,
};

let rootEl = null;
let pushTimer = null;

// ---------- 保存（表示キャッシュ） ----------

function loadItems() {
  try {
    const raw = localStorage.getItem(LS_KEY_HABIT_ITEMS);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) return arr;
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
  const shown = valueLabel(item, v);
  return `
    <li class="habit-item" data-id="${escapeHtml(item.id)}">
      ${del}
      ${icon}
      <span class="habit-label">${escapeHtml(item.label)}</span>
      <button class="habit-value ${shown ? "filled" : ""}">${shown || "タップで入力"}</button>
    </li>`;
}

function paint() {
  if (!rootEl) return;
  rootEl.innerHTML = `
    <div class="habit-tab">
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
  rootEl.querySelector("#h-add").addEventListener("click", openAddModal);

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
      li.querySelector(".habit-value").addEventListener("click", () => {
        if (justDragged()) return;
        openValueModal(item);
      });
    }
    if (state.editMode) {
      li.querySelector(".habit-label").addEventListener("click", (e) => {
        e.stopPropagation();
        renameItem(id);
      });
    }
  });

  enableLongPressReorder(listEl, {
    itemSelector: ".habit-item",
    onReorder: onReorderItems,
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

function setValue(id, value) {
  const next = { ...state.values };
  if (value === "" || value == null || value === false) delete next[id];
  else next[id] = value;
  state.values = next;
  saveDayLocal(state.date, next);
  paint();
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

function renameItem(id) {
  const item = state.items.find((x) => x.id === id);
  if (!item) return;
  const name = prompt("項目名を入力", item.label);
  if (name == null) return;
  const t = name.trim();
  if (!t) return;
  item.label = t;
  saveItemsLocal(state.items);
  paint();
  pushItems(state.items);
}

function openAddModal() {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <header>項目を追加</header>
      <div class="modal-body">
        <label>項目名
          <input type="text" id="a-label" autocomplete="off" />
        </label>
        <label>種類
          <select id="a-type">
            <option value="check">チェック</option>
            <option value="number">数値</option>
            <option value="time">時刻</option>
          </select>
        </label>
        <label>単位（数値のみ・例: 分）
          <input type="text" id="a-unit" autocomplete="off" />
        </label>
      </div>
      <footer>
        <div style="flex:1"></div>
        <button class="btn-ghost" id="a-cancel">キャンセル</button>
        <button class="btn-primary" id="a-save">追加</button>
      </footer>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector("#a-cancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  modal.querySelector("#a-save").addEventListener("click", () => {
    const label = modal.querySelector("#a-label").value.trim();
    if (!label) {
      toast("項目名を入力してください", "error");
      return;
    }
    const type = modal.querySelector("#a-type").value;
    const unit = type === "number" ? modal.querySelector("#a-unit").value.trim() : "";
    state.items = [
      ...state.items,
      { id: "c_" + Date.now(), label, icon: "•", type, unit },
    ];
    saveItemsLocal(state.items);
    close();
    paint();
    pushItems(state.items);
  });
  setTimeout(() => modal.querySelector("#a-label").focus(), 50);
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
    await flushHabitOutbox();
    const [items, values] = await Promise.all([
      gas.pullHabitItems(),
      gas.pullHabitDay(ymd),
    ]);
    if (seq !== syncSeq || !rootEl) return;
    let changed = false;
    if (Array.isArray(items) && items.length > 0) {
      state.items = items;
      saveItemsLocal(items);
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
      state.items = items;
      saveItemsLocal(items);
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
