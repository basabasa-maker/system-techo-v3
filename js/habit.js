// habit.js - 習慣タブ（旧アプリ「習慣ログ」を手帳に統合）
// - 日付ごとに 時刻・数値・チェック・文章 を記録する
// - 各項目は長押しで上下に移動できる（reorder.js）
// - 保存は日付1件ずつ。全件の取得・上書きはしない
// - 旧アプリの過去データは取り込まない（白紙から開始）

import * as gas from "./gas-client.js";
import { habitIconContents, habitIconOptions } from "./habit/icons.js";
import * as sync from "./sync.js";
import { bindHabitTextInput, persistHabitText, replayHabitTextRecovery, getHabitTextRecoveryDates, markHabitValueChanged, invalidateHabitTextItem } from "./habit/text.js";
import { latestMealTime } from "./meal-time.js";
import { healthBridge, loadHealthSettings, saveHealthSettings, REQUEST_TTL_MS } from "./health/bridge.js";
import { selectHealthPatch } from "./health/model.js";
import { confirmHealthValues, showHealthStepObservation } from "./health/ui.js";
import {
  HABIT_DEFAULT_ITEMS,
  LS_KEY_HABIT_DAY_PREFIX,
  LS_KEY_HABIT_ITEMS,
} from "./config.js";
import { toast, showSpinner, hideSpinner } from "./toast.js";
import { todayYmd, addDaysYmd, parseYmd, pad2 } from "./date-util.js";
import { enableLongPressReorder, justDragged } from "./reorder.js";
import { loadRange, renderCharts, renderHistory, RANGES, getRangeDays, setRangeDays } from "./habit-stats.js";

const state = {
  date: todayYmd(),
  items: [],
  values: {},
  editMode: false,
  sub: "input", // input | chart | hist
};

let rootEl = null;
let healthTimer = null;
let healthResumePromise = null;
let healthPollUntil = 0;
let healthReady = null;
let healthMessage = "";
let healthSaving = false;
let healthPaintPending = false;
export const HEALTH_SYNC_EVENT = "system-techo:health-sync";
let textInputs = [];
function flushTextInputs() {
  // Commit the original date/id before any DOM or navigation change.
  return textInputs.every(controller => controller.flush());
}
export function hasUnsavedHabitText() {
  return textInputs.some(controller => controller.isDirty());
}
export function disposeHabitTab() {
  if (!flushTextInputs()) return false;
  textInputs = [];
  return true;
}


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
  resumeHealthSync();
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
  const icon = `<span class="habit-icon">${habitIconContents(item.icon)}</span>`;
  const del = state.editMode
    ? `<button class="habit-del" data-del="${escapeHtml(item.id)}" aria-label="削除">−</button>`
    : "";
  if (item.type === "text") {
    return '<li class="habit-item habit-text-row" data-id="' + escapeHtml(item.id) + '">'
      + del + icon + '<span class="habit-label">' + escapeHtml(item.label) + '</span>'
      + '<button class="habit-clear" aria-label="文章を消す" ' + (v != null && v !== "" ? "" : "hidden") + '><img src="icons/eraser.png" alt="" width="24" height="24" /></button>'
      + '<textarea rows="3" class="habit-value-input habit-text-input" aria-label="' + escapeHtml(item.label) + '" placeholder="文章を入力"></textarea></li>';
  }
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
      : `<input type="number" inputmode="${isInt ? "numeric" : "decimal"}" step="${isInt ? "1" : "any"}" placeholder="${isCum ? "0" : "入力"}" class="habit-value habit-value-input ${filled ? "filled" : ""}" value="${filled ? escapeHtml(v) : ""}" />`;
  // 単位欄は空でも幅を確保し、入力欄の左右位置を全項目でそろえる
  const unit = `<span class="habit-unit-out">${item.type !== "time" && item.unit ? escapeHtml(item.unit) : ""}</span>`;
  // 累積の項目：欄に入れた数が、そのまま合計に足される。合計は項目名の下に出す
  const tail = `<button class="habit-clear" aria-label="${isCum ? "合計を0に戻す" : "消す"}" ${filled ? "" : "hidden"}><img src="icons/eraser.png" alt="" width="24" height="24" /></button>`;
  return `
    <li class="habit-item" data-id="${escapeHtml(item.id)}">
      ${del}
      ${icon}
      <span class="habit-label">${escapeHtml(item.label)}${isCum ? `<small class="habit-cum">${filled ? "計 " + escapeHtml(v) : ""}</small>` : ""}</span>
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
      if (!flushTextInputs()) return;
      state.sub = b.dataset.sub;
      state.editMode = false;
      paint();
    });
  });
}

let statsSeq = 0;
async function paintStats() {
  const seq = ++statsSeq;
  const view = rootEl;
  const rangeHtml = `<div class="habit-ranges">${RANGES.map((r) => `<button class="habit-range ${getRangeDays() === r.days ? "on" : ""}" data-days="${r.days}">${r.label}</button>`).join("")}</div>`;
  rootEl.innerHTML = `<div class="habit-tab">${subTabsHtml()}${rangeHtml}<div id="habit-stats" class="habit-stats"><p class="empty-hint">読み込み中…</p></div></div>`;
  bindSubTabs();
  rootEl.querySelectorAll(".habit-range").forEach((b) => {
    b.addEventListener("click", () => {
      setRangeDays(Number(b.dataset.days));
      paintStats();
    });
  });
  const sub = state.sub;
  const data = await loadRange();
  const box = rootEl && rootEl.querySelector("#habit-stats");
  if (!box || seq !== statsSeq || view !== rootEl || !view.isConnected || state.sub !== sub) return;
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
  if (!rootEl?.isConnected || !flushTextInputs()) return;
  textInputs = [];
  if (state.sub !== "input") {
    paintStats();
    return;
  }
  healthPaintPending = false;
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
    if (!flushTextInputs()) return;
    state.date = todayYmd();
    reloadDay();
  });
  rootEl.querySelector("#h-edit").addEventListener("click", () => {
    if (!flushTextInputs()) return;
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
    if (item.type === "text") {
      const input = li.querySelector("textarea");
      // Property assignment preserves a leading LF that HTML textarea parsing strips.
      input.value = state.values[id] == null ? "" : String(state.values[id]);
      input.classList.toggle("filled", input.value !== "");
      const date = state.date;
      const controller = bindHabitTextInput(input, {
        key: date + ":" + id,
        commit: value => setTextValue(date, id, value),
        onError: () => toast("文章を端末に保存できません。画面を閉じずに再試行してください", "error"),
      });
      textInputs.push(controller);
      li.querySelector(".habit-clear").addEventListener("click", () => {
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    } else if (item.type === "check") {
      li.addEventListener("click", (e) => {
        if (justDragged() || e.target.closest(".habit-del")) return;
        toggleCheck(id);
      });
    } else {
      const inp = li.querySelector(".habit-value-input");
      const clr = li.querySelector(".habit-clear");
      const commit = () => {
        const raw = inp.value;
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
      if (item.type === "cumulative") {
        // 欄が合計を表す。押すと前の数字が消え、入れた数が足される。前の合計は項目名の下に小さく残る
        const cum = li.querySelector(".habit-cum");
        const showCum = () => {
          if (cum) cum.textContent = state.values[id] != null ? "計 " + state.values[id] : "";
        };
        const wipe = () => {
          const cur = Number(state.values[id]) || 0;
          inp.placeholder = String(cur);
          inp.value = "";
        };
        inp.addEventListener("focus", () => {
          wipe();
        });
        inp.addEventListener("blur", () => {
          const cur = Number(state.values[id]) || 0;
          const raw = inp.value;
          const n = Math.round(Number(raw));
          let total = cur;
          if (raw !== "" && Number.isFinite(n) && n !== 0) {
            total = cur + n;
            setValue(id, total, true);
          }
          inp.placeholder = "0";
          inp.value = total || (state.values[id] != null ? String(total) : "");
          inp.classList.toggle("filled", state.values[id] != null);
          clr.hidden = state.values[id] == null;
          showCum();
        });
      } else {
        inp.addEventListener("change", commit);
      }
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
  if (!flushTextInputs()) return;
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
  // Keep even an edit later restored to its original value protected from a delayed result.
  try { healthBridge.markEdited(id, state.date); }
  catch (_) { healthBridge.cancel(); }
  const next = { ...state.values };
  const erase = value === "" || value == null || value === false;
  if (erase) delete next[id];
  else next[id] = value;
  state.values = next;
  saveDayLocal(state.date, next);
  markHabitValueChanged(state.date, id);
  if (quiet) {
    // 入力中の欄を作り直さない。睡眠時間だけ更新する
    const el = rootEl && rootEl.querySelector(".habit-sleep-val");
    if (el) el.textContent = sleepLabel(next);
  } else {
    paint();
  }
  schedulePush(state.date, erase ? { [id]: undefined } : { [id]: value }, erase);
}

// Text listeners retain their rendered date even after that DOM is detached.
function setTextValue(ymd, id, value) {
  const raw = localStorage.getItem(LS_KEY_HABIT_DAY_PREFIX + ymd);
  const before = raw == null ? {} : JSON.parse(raw);
  if (!before || typeof before !== "object" || Array.isArray(before)) throw new Error("日別の記録を確認できません");
  if ((before[id] == null ? "" : String(before[id])) === value) return;
  const next = value === "" ? { ...before } : { ...before, [id]: value };
  if (value === "") delete next[id];
  // Keep a recovery marker until this one-field patch is durable in the outbox.
  const queued = persistHabitText(ymd, id, value, () => saveDayLocal(ymd, next));
  if (state.date === ymd) state.values = next;
  try { healthBridge.markEdited(id, ymd); } catch (_) { healthBridge.cancel(); }
  queued.catch(() => toast("文章は端末に残しています。送信できないため再試行してください", "error"));
}

function toggleCheck(id) {
  setValue(id, state.values[id] === true ? false : true);
}

// 入力確定後すぐ永続キューへ。送信中も pendingKeys で保護する。
function schedulePush(ymd, change, erase) {
  const id = Object.keys(change)[0];
  sync.queue({ type: "habit_day_upsert", payload: {
    date: ymd, set: erase ? {} : change, del: erase ? [id] : [],
  }}).catch(() => toast("端末への保存に失敗しました。画面を閉じずに再試行してください", "error"));
}

function pushItems(items) {
  return sync.queue({ type: "habit_items_upsert", payload: { items } })
    .catch(() => toast("項目の保存に失敗しました", "error"));
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


// 項目の追加・編集（アイコン・名前・入力方式・単位）
function openItemEditor(id) {
  if (!flushTextInputs()) return;
  const item = id ? state.items.find((x) => x.id === id) : null;
  if (id && !item) return;
  let icon = item ? item.icon || "•" : "🌙";
  const type = item ? (item.type === "number" ? "decimal" : item.type) : "integer";
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <header>${item ? "項目を編集" : "項目を追加"}</header>
      <div class="modal-body">
        <div class="icon-grid habit-icon-grid" role="group" aria-label="アイコン">${habitIconOptions(icon)}</div>
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
            <option value="text">文章（改行できます）</option>
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
      typeSel.value === "check" || typeSel.value === "time" || typeSel.value === "text" ? "none" : "";
  };
  typeSel.addEventListener("change", syncUnit);
  syncUnit();
  modal.querySelectorAll(".icon-opt").forEach((b) => {
    b.addEventListener("click", () => {
      modal.querySelectorAll(".icon-opt").forEach((x) => { x.classList.remove("sel"); x.setAttribute("aria-pressed", "false"); });
      b.classList.add("sel");
      b.setAttribute("aria-pressed", "true");
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
    const unit = t === "check" || t === "time" || t === "text" ? "" : modal.querySelector("#e-unit").value.trim();
    const next = { ...(item || {}), id: item ? item.id : "c_" + Date.now(), label, icon, type: t, unit };
    state.items = item
      ? state.items.map((x) => (x.id === item.id ? next : x))
      : [...state.items, next];
    saveItemsLocal(state.items);
    if (item && item.type !== t) invalidateHabitTextItem(item.id);
    close();
    paint();
    pushItems(state.items);
  });
  if (!item) setTimeout(() => modal.querySelector("#e-label").focus({ preventScroll: true }), 50);
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
  setTimeout(() => modal.querySelector("#v-input").focus({ preventScroll: true }), 50);
}

// "2:00" / "02:00" → "02:00"
function toHhMm(v) {
  const m = String(v || "").match(/^(\d{1,2}):(\d{2})/);
  return m ? `${pad2(parseInt(m[1], 10))}:${m[2]}` : "";
}

// ---------- 同期 ----------

let syncSeq = 0;

async function syncFromServer(quiet = true, importLastMeal = false) {
  const seq = ++syncSeq;
  const view = rootEl;
  const ymd = state.date;
  const previousDate = addDaysYmd(ymd, -1);
  const mealKey = "meal:" + previousDate;
  // 更新開始後は、送信待ちの処理中に確定した手入力も自動値で戻さない。
  const refreshDayRevision = sync.revision("habit_day:" + ymd);
  try {
    await replayHabitTextRecovery();
    await flushHabitOutbox().catch(() => {});
    const dayRevision = sync.revision("habit_day:" + ymd);
    const itemRevision = sync.revision("habit_items");
    const mealRevision = sync.revision(mealKey);
    // 食事の追加取得は、習慣タブの手動更新時だけ。取得失敗でも通常の習慣同期は残す。
    const [items, values, mealResult] = await Promise.all([
      gas.pullHabitItems(), gas.pullHabitDay(ymd),
      importLastMeal ? gas.pullMealMonth(previousDate.slice(0, 7))
        .then((days) => ({ days }), (error) => ({ error })) : null,
    ]);
    const keys = await sync.pendingKeys();
    for (const date of getHabitTextRecoveryDates()) keys.add("habit_day:" + date);
    if (seq !== syncSeq || view !== rootEl || !view?.isConnected || state.date !== ymd) return;
    // キーボード／時刻ピッカーを開いている間は state と DOM の両方を維持。
    if (view.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)
        || document.querySelector(".modal-backdrop")) return;
    let changed = false;
    if (!keys.has("habit_items") && itemRevision === sync.revision("habit_items") && Array.isArray(items) && items.length > 0) {
      state.items = normalizeItems(items);
      saveItemsLocal(state.items);
      changed = true;
    }
    if (!keys.has("habit_day:" + ymd) && dayRevision === sync.revision("habit_day:" + ymd) && values && typeof values === "object") {
      state.values = values;
      saveDayLocal(ymd, values);
      changed = true;
    }
    let lastMealSave = null;
    const lastMeal = latestMealTime(mealResult?.days?.[previousDate]);
    if (lastMeal !== null && state.values.lastMeal !== lastMeal
        && state.items.some((item) => item.id === "lastMeal" && item.type === "time")
        && !keys.has("habit_items") && itemRevision === sync.revision("habit_items")
        && !keys.has("habit_day:" + ymd) && dayRevision === sync.revision("habit_day:" + ymd)
        && refreshDayRevision === sync.revision("habit_day:" + ymd)
        && !keys.has(mealKey) && mealRevision === sync.revision(mealKey)) {
      state.values = { ...state.values, lastMeal };
      saveDayLocal(ymd, state.values);
      // 習慣を全日置換せず、この1項目だけを既存の永続キューへ入れる。
      lastMealSave = sync.queue({ type: "habit_day_upsert", payload: {
        date: ymd, set: { lastMeal }, del: [],
      } });
      changed = true;
    }
    if (changed) paint();
    if (lastMealSave) await lastMealSave;
    if (mealResult?.error) throw mealResult.error;
  } catch (e) {
    console.warn("habit sync skipped:", e.message);
    if (!quiet) throw e;
  }
}

export async function flushHabitOutbox() {
  return sync.flushAll();
}

// 更新ボタンから呼ばれる
export async function pullAndRender() {
  // ボタンを押しても入力欄にフォーカスが残る端末では、先に入力を確定する。
  // 自動同期や、更新開始後に再び入力した場合の保護はそのまま残す。
  const focused = document.activeElement;
  if (rootEl?.contains(focused) && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName)) {
    focused.blur();
  }
  try {
    if (state.sub === "input" && loadHealthSettings().enabled) {
      if (healthResumePromise) { toast("ヘルスケアの取り込み処理中です");return; }
      const pending = healthBridge.pending();
      if (pending?.date === state.date && Date.now() - pending.issued_at < REQUEST_TTL_MS
          && pending.issued_at - Date.now() <= 120000) {
        // A successful Shortcut upload is bound to this nonce. Retrying the
        // receive step must not orphan it by launching a different request.
        toast("前回の読み取り結果を確認しています。最初からやり直す場合は設定のヘルスケア連携で中止してください。");
        resumeHealthSync();
        return;
      }
      launchHealthRead();
      return;
    }
  } catch (error) { toast(error.message, "error");return; }
  showSpinner();
  try {
    await syncFromServer(false, true);
    toast("更新を確認しました" + (await sync.pendingNote()), "success");
  } catch (e) {
    toast("取得に失敗しました: " + e.message, "error");
  } finally {
    hideSpinner();
  }
}


// ---------- iPhone Health bridge (only an explicitly requested day) ----------
// The diagnostic uses the existing Shortcut and POST protocol, but its local
// pending mode never enters the ordinary habit refresh or save path.
function launchHealthRead(options = {}) {
  clearTimeout(healthTimer);
  healthReady = null;
  const { url } = healthBridge.prepare(state.date, state.values, options);
  healthMessage = options.mode === "inspect"
    ? "歩数を確認するため読み取り中です。この確認ではヘルスケアの値を保存しません。元の手帳へ戻ってください。"
    : "ショートカットで読み取り中です。完了したら元の手帳へ戻ってください。";
  notifyHealthSyncChange();
  // Keep the OS handoff synchronous with the user's click, including Settings.
  window.location.assign(url);
  healthPollUntil = Date.now() + 60000;
  healthTimer = setTimeout(() => resumeHealthSync(true), 1500);
}
export function inspectHealthSteps() {
  try {
    if (!rootEl?.isConnected || state.sub !== "input") {
      toast("習慣の入力画面で、歩数を確認してください。", "error");return false;
    }
    if (!loadHealthSettings().enabled) {
      toast("先にヘルスケア連携を設定してください。", "error");return false;
    }
    if (healthResumePromise || healthSaving || healthBridge.pending()) {
      toast("読み取り処理中です。完了してから歩数を確認してください。", "error");return false;
    }
    launchHealthRead({mode:"inspect"});
    return true;
  } catch (error) { toast(error.message, "error");return false; }
}


// Settings reads only this presentation state; credentials and measurements stay private.
export function getHealthSyncView() {
  try {
    const settings = loadHealthSettings();
    const request = healthBridge.pending();
    const last = healthBridge.lastSync();
    let message = (healthSaving ? "読み取り結果を保存しています…" : healthMessage)
      || (request ? `${request.date} の読み取り待ちです。`
        : last ? `${last.date}：前回${last.keys.length}項目を取り込みました。`
          : settings.enabled ? "習慣の入力画面の更新でヘルスケアを読み取ります。"
            : "ヘルスケア連携は停止中です。");
    if (request && !message.includes(request.date)) message = `${request.date}：${message}`;
    return { message, pending: !!request, saving: healthSaving, enabled: settings.enabled,
      inspectAvailable: !!rootEl?.isConnected && state.sub === "input" && !healthResumePromise };
  } catch (_) {
    return { message: "連携設定を確認してください。", pending: false, saving: healthSaving, enabled: false, inspectAvailable: false };
  }
}
export function cancelHealthSync() {
  if (healthSaving) return false;
  healthBridge.cancel();
  healthReady = null;
  clearTimeout(healthTimer);
  healthMessage = "取り込みを中止しました。";
  notifyHealthSyncChange();
  return true;
}
export function healthSettingsChanged() {
  healthMessage="";healthReady=null;clearTimeout(healthTimer);notifyHealthSyncChange();
}
function notifyHealthSyncChange() {
  document.dispatchEvent(new CustomEvent(HEALTH_SYNC_EVENT));
}
export function resumeHealthAfterSettings() {
  // A save can complete while Settings covers the input screen. Catch up only
  // that deferred paint after the modal closes, without reloading any records.
  if (healthPaintPending && rootEl?.isConnected && state.sub === "input" && !healthInputBusy()) paint();
  return resumeHealthSync();
}
function healthInputBusy() {
  return rootEl?.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)
    || !!document.querySelector(".modal-backdrop");
}
function healthContext(request) {
  const current = healthBridge.pending();
  return rootEl?.isConnected && state.sub === "input" && state.date === request.date
    && document.visibilityState !== "hidden" && current?.request_id === request.request_id
    && current.mode === request.mode;
}
function scheduleHealth(request, delay=1500) {
  clearTimeout(healthTimer);
  if (Date.now() < healthPollUntil && healthContext(request)) healthTimer=setTimeout(()=>resumeHealthSync(true),delay);
}
export function resumeHealthSync(internal = false) {
  let request;
  try { request=healthBridge.pending(); }
  catch (error) { healthMessage=error.message;notifyHealthSyncChange();return false; }
  if (!request || !loadHealthSettings().enabled || !rootEl?.isConnected || state.sub !== "input" || document.visibilityState === "hidden") return false;
  if (request.date !== state.date) {
    healthBridge.cancel();healthReady=null;healthMessage="表示日が変わったため、取り込んでいません。対象日で更新してください。";notifyHealthSyncChange();return false;
  }
  if (healthResumePromise) return true;
  if (!internal) healthPollUntil=Date.now()+60000;
  healthResumePromise=receiveHealth(request).catch(error=>{
    if (healthBridge.pending()?.request_id !== request.request_id) return;
    const expired = Date.now()-request.issued_at >= REQUEST_TTL_MS || request.issued_at-Date.now() > 120000;
    const message = expired ? "読み取りが期限切れです。もう一度更新してください。"
      : "読み取り結果をまだ受け取れていません。手帳に戻るか更新を押すと、同じ結果の受け取りを再開します。";
    const changed = healthMessage !== message;
    if (expired) { healthBridge.cancel();healthReady=null; }
    else { scheduleHealth(request); }
    // Background fetches can fail while iPhone switches apps. Retain the
    // explicit request (and any already checked result) for resume events.
    healthMessage=message;notifyHealthSyncChange();
    if (changed && document.visibilityState !== "hidden") toast(healthMessage,"error");
  }).finally(()=>{healthResumePromise=null;healthSaving=false;notifyHealthSyncChange();});
  return true;
}
async function receiveHealth(request) {
  if (Date.now()-request.issued_at >= REQUEST_TTL_MS) throw new Error("読み取りが期限切れです。もう一度更新してください。");
  const cached=healthReady?.request_id === request.request_id ? healthReady : null;
  const values=cached ? cached.values : await healthBridge.read(request);
  if (!healthContext(request)) return;
  if (values === null) { scheduleHealth(request);return; }
  healthReady={request_id:request.request_id,values,receivedAt:cached?.receivedAt ?? Date.now()};
  if (healthInputBusy()) { scheduleHealth(request,500);return; }
  if (request.mode === "inspect") {
    await showHealthStepObservation(request.date, {
      steps:values.steps, current:loadDay(request.date).steps, receivedAt:healthReady.receivedAt,
    });
    if (await healthBridge.finish(request,[],[],{recordSync:false})) {
      if (healthReady?.request_id === request.request_id) healthReady=null;
      healthMessage="歩数の確認を終了しました。この確認ではヘルスケアの値を保存していません。";
      notifyHealthSyncChange();
    }
    return;
  }
  let settings=loadHealthSettings();
  const receivedKeys=Object.keys(values);
  const needsCheck=receivedKeys.some(key=>!settings.verifiedKeys.includes(key));
  if (needsCheck) {
    const accepted=await confirmHealthValues(request.date,values);
    if (!healthContext(request)) return;
    if (!accepted) {
      await healthBridge.finish(request,[],receivedKeys);
      healthReady=null;healthMessage="ヘルスケアの取り込みを中止しました。記録は変更していません。";notifyHealthSyncChange();return;
    }
    settings=loadHealthSettings();
    saveHealthSettings({...settings,verifiedKeys:[...new Set([...settings.verifiedKeys,...receivedKeys])]});
  }
  if (Date.now()-request.issued_at >= REQUEST_TTL_MS) throw new Error("読み取りが期限切れです。もう一度更新してください。");
  // Continue the same manual update after returning, including the existing last-meal import.
  await syncFromServer(false,true);
  if (!healthContext(request)) return;
  if (healthInputBusy()) { scheduleHealth(request,500);return; }
  const keys=await sync.pendingKeys();
  if (!healthContext(request) || healthInputBusy()) { scheduleHealth(request,500);return; }
  // The page may have been suspended during the ordinary network refresh.
  if (Date.now()-request.issued_at >= REQUEST_TTL_MS) throw new Error("読み取りが期限切れです。もう一度更新してください。");
  const latest=healthBridge.pending();
  const untouched=Object.fromEntries(Object.entries(values).filter(([key])=>!latest.editedKeys?.includes(key)));
  const before=loadDay(request.date);
  const patch=keys.has("habit_day:"+request.date) ? {} : selectHealthPatch(before,request.baseline,untouched,state.items);
  const appliedKeys=Object.keys(patch);
  const skipped=receivedKeys.filter(key=>!appliedKeys.includes(key) && !Object.is(before[key],values[key]));
  if (appliedKeys.length) {
    healthSaving=true;notifyHealthSyncChange();
    // Persist to the existing queue before announcing success or discarding the temporary result.
    await sync.queue({type:"habit_day_upsert",payload:{date:request.date,set:patch,del:[]}},300);
    const fresh=loadDay(request.date), stillPending=healthBridge.pending();
    if (stillPending?.request_id !== request.request_id) return;
    const safePatch=Object.fromEntries(Object.entries(patch).filter(([key])=>!stillPending?.editedKeys?.includes(key) && Object.is(fresh[key],before[key])));
    const merged={...fresh,...safePatch};
    saveDayLocal(request.date,merged);
    if (rootEl?.isConnected && state.date===request.date) {
      state.values=merged;
      if (!healthInputBusy()) paint();
      else healthPaintPending=true;
    }
    await sync.flushAll();
  }
  if (!await healthBridge.finish(request,appliedKeys,skipped)) return;
  healthReady=null;
  healthMessage=!receivedKeys.length ? "この日のヘルスケア値を取得できませんでした。読み取り許可・条件を確認してください。保存済みの4項目は変更していません。" : skipped.length ? `${appliedKeys.length}項目を取り込み、変更中などの${skipped.length}項目はそのまま残しました。` : appliedKeys.length ? `ヘルスケア${appliedKeys.length}項目を取り込みました。` : "ヘルスケアの値を確認しました。変更はありません。";
  notifyHealthSyncChange();toast(healthMessage + await sync.pendingNote(),"success");
}
