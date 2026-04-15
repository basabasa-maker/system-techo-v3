// daily.js - Daily タブ（時間軸ビュー + 当日Journal追記 + 関連Task表示）
// - 縦軸: 0:00〜24:00、15分=12px、1時間=48px
// - 初期表示: 現在時刻±6時間を画面中央
// - 9カレンダー色分け（config.js CALENDAR_DEFS のcolor）
// - 終日予定は時間軸上部に横帯表示
// - FAB で Journal 追加モーダル（時刻スロット・本文）

import * as store from "./store.js";
import * as gas from "./gas-client.js";
import * as outbox from "./outbox.js";
import { CALENDAR_DEFS, calendarColorFor } from "./config.js";
import { toast, showSpinner, hideSpinner } from "./toast.js";
import {
  todayYmd,
  nowJst,
  parseHhMm,
  addDaysYmd,
  formatYmdLong,
  nowQuarter,
  pad2,
} from "./date-util.js";

const HOUR_HEIGHT = 48; // px per hour
const MIN_TO_PX = HOUR_HEIGHT / 60;

const state = {
  date: todayYmd(),
};

let rootEl = null;

export function renderDailyTab(container) {
  rootEl = container;
  state.date = todayYmd();
  container.innerHTML = `
    <div class="daily-tab">
      <div class="daily-datenav">
        <button class="nav-btn" id="nav-prev" aria-label="前日">◀</button>
        <button class="nav-date" id="nav-date">${formatYmdLong(state.date)}</button>
        <button class="nav-btn" id="nav-next" aria-label="翌日">▶</button>
      </div>
      <div class="daily-allday" id="daily-allday"></div>
      <div class="daily-timeline-wrap">
        <div class="daily-timeline" id="daily-timeline">
          ${renderHourGrid()}
          <div class="now-line" id="now-line"></div>
          <div class="events-layer" id="events-layer"></div>
        </div>
      </div>
      <div class="daily-related">
        <h3>この日のタスク</h3>
        <ul class="daily-task-list" id="daily-task-list"></ul>
      </div>
    </div>
  `;

  container.querySelector("#nav-prev").addEventListener("click", () => {
    state.date = addDaysYmd(state.date, -1);
    reRender();
  });
  container.querySelector("#nav-next").addEventListener("click", () => {
    state.date = addDaysYmd(state.date, 1);
    reRender();
  });
  container.querySelector("#nav-date").addEventListener("click", () => {
    openDatePicker();
  });

  paintEvents();
  paintTasks();
  scrollToCurrentHour();
}

function reRender() {
  if (!rootEl) return;
  renderDailyTab(rootEl);
}

function renderHourGrid() {
  let html = "";
  for (let h = 0; h <= 24; h++) {
    const top = h * HOUR_HEIGHT;
    html += `<div class="hour-row" style="top:${top}px">
      <span class="hour-label">${pad2(h)}:00</span>
      <div class="hour-line"></div>
    </div>`;
  }
  return html;
}

function paintEvents() {
  const events = store.loadCalendar(state.date);
  const allDayEl = rootEl.querySelector("#daily-allday");
  const layerEl = rootEl.querySelector("#events-layer");
  if (!allDayEl || !layerEl) return;

  const allDay = events.filter((e) => e.all_day);
  const timed = events.filter((e) => !e.all_day);

  // 終日予定
  if (allDay.length === 0) {
    allDayEl.innerHTML = "";
  } else {
    let h = "";
    for (const ev of allDay) {
      const color = calendarColorFor(ev.calendar_id);
      h += `<div class="allday-chip" style="background:${color}">
        <span class="ev-title">${escapeHtml(ev.summary || "(無題)")}</span>
        <span class="ev-cal">${escapeHtml(ev.calendar_label || "")}</span>
      </div>`;
    }
    allDayEl.innerHTML = h;
  }

  // 時間指定予定
  let html = "";
  for (const ev of timed) {
    const s = parseHhMm(ev.start);
    const e = parseHhMm(ev.end);
    if (!s) continue;
    const startMin = s.hour * 60 + s.minute;
    const endMin = e ? e.hour * 60 + e.minute : startMin + 30;
    const top = startMin * MIN_TO_PX;
    const height = Math.max(18, (endMin - startMin) * MIN_TO_PX);
    const color = calendarColorFor(ev.calendar_id);
    const compact = height < 34;
    const timeLabel = `${pad2(s.hour)}:${pad2(s.minute)}${e ? "〜" + pad2(e.hour) + ":" + pad2(e.minute) : ""}`;
    html += `<div class="event-block" style="top:${top}px;height:${height}px;background:${color}">
      <div class="event-title">${escapeHtml(ev.summary || "(無題)")}</div>
      ${compact ? "" : `<div class="event-time">${escapeHtml(timeLabel)}</div>`}
    </div>`;
  }
  layerEl.innerHTML = html;

  // 現在時刻ライン（今日の場合のみ）
  const nowLineEl = rootEl.querySelector("#now-line");
  if (nowLineEl) {
    if (state.date === todayYmd()) {
      const d = new Date();
      const min = d.getHours() * 60 + d.getMinutes();
      nowLineEl.style.display = "block";
      nowLineEl.style.top = `${min * MIN_TO_PX}px`;
    } else {
      nowLineEl.style.display = "none";
    }
  }
}

function paintJournal() {
  const listEl = rootEl.querySelector("#daily-journal-list");
  if (!listEl) return;
  const entries = store.loadJournal(state.date);
  if (entries.length === 0) {
    listEl.innerHTML = `<li class="empty-hint-sm">まだジャーナルはありません</li>`;
    return;
  }
  let h = "";
  for (const en of entries) {
    const hour =
      en.hour_slot != null && en.hour_slot !== ""
        ? `${pad2(parseInt(en.hour_slot, 10))}時台`
        : "";
    h += `<li class="journal-item" data-id="${escapeHtml(en.id)}">
      <div class="journal-meta">${escapeHtml(hour)}</div>
      ${en.title ? `<div class="journal-title">${escapeHtml(en.title)}</div>` : ""}
      <div class="journal-body">${escapeHtml(en.body || "")}</div>
    </li>`;
  }
  listEl.innerHTML = h;
  listEl.querySelectorAll(".journal-item").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.dataset.id;
      const en = store.loadJournal(state.date).find((x) => x.id === id);
      if (en) openJournalEditor(en);
    });
  });
}

function paintTasks() {
  const listEl = rootEl.querySelector("#daily-task-list");
  if (!listEl) return;
  const tasks = store
    .loadTasks()
    .filter((t) => !t.deleted && t.due_date === state.date);
  if (tasks.length === 0) {
    listEl.innerHTML = `<li class="empty-hint-sm">この日のタスクはありません</li>`;
    return;
  }
  let h = "";
  for (const t of tasks) {
    const doneCls = t.status === "done" ? "is-done" : "";
    h += `<li class="daily-task-item ${doneCls}">
      <span class="task-priority pri-${t.priority || "mid"}">${t.priority === "high" ? "高" : t.priority === "low" ? "低" : "中"}</span>
      <span class="task-title">${escapeHtml(t.title)}</span>
    </li>`;
  }
  listEl.innerHTML = h;
}

function scrollToCurrentHour() {
  const wrap = rootEl.querySelector(".daily-timeline-wrap");
  if (!wrap) return;
  const d = new Date();
  let centerMin;
  if (state.date === todayYmd()) {
    centerMin = d.getHours() * 60 + d.getMinutes();
  } else {
    centerMin = 12 * 60;
  }
  const centerPx = centerMin * MIN_TO_PX;
  const visibleH = wrap.clientHeight || 400;
  wrap.scrollTop = Math.max(0, centerPx - visibleH / 2);
}

// ---------- Journal editor modal ----------

function openJournalEditor(existing) {
  const isNew = !existing;
  const q = nowQuarter();
  const en = existing || {
    id: cryptoUuid(),
    entry_type: "journal",
    date: state.date,
    hour_slot: String(q.hour),
    title: "",
    body: "",
    tags: "",
    created_at: nowJst(),
    updated_at: nowJst(),
    deleted: 0,
  };

  const hourOptions = Array.from({ length: 24 }, (_, i) => {
    const sel = String(i) === String(en.hour_slot) ? "selected" : "";
    return `<option value="${i}" ${sel}>${pad2(i)}:00</option>`;
  }).join("");

  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <header>${isNew ? "ジャーナル追加" : "ジャーナル編集"}</header>
      <div class="modal-body">
        <label>時間帯
          <select id="j-hour">${hourOptions}</select>
        </label>
        <label>タイトル（任意）
          <input type="text" id="j-title" value="${escapeHtml(en.title || "")}" autocomplete="off" />
        </label>
        <label>本文
          <textarea id="j-body" rows="5">${escapeHtml(en.body || "")}</textarea>
        </label>
      </div>
      <footer>
        ${isNew ? "" : '<button class="btn-danger" id="j-delete">削除</button>'}
        <div style="flex:1"></div>
        <button class="btn-ghost" id="j-cancel">キャンセル</button>
        <button class="btn-primary" id="j-save">保存</button>
      </footer>
    </div>`;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector("#j-cancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });

  modal.querySelector("#j-save").addEventListener("click", async () => {
    const body = modal.querySelector("#j-body").value.trim();
    if (!body) {
      toast("本文を入力してください", "error");
      return;
    }
    const updated = {
      ...en,
      hour_slot: modal.querySelector("#j-hour").value,
      title: modal.querySelector("#j-title").value.trim(),
      body: body,
      updated_at: nowJst(),
      deleted: 0,
    };
    close();
    await saveJournal(updated);
  });

  const delBtn = modal.querySelector("#j-delete");
  if (delBtn) {
    delBtn.addEventListener("click", async () => {
      if (!confirm("このジャーナルを削除しますか？")) return;
      close();
      await deleteJournal(en.id);
    });
  }

  setTimeout(() => modal.querySelector("#j-body").focus(), 50);
}

function openDatePicker() {
  // type=date inputを一時生成してclick
  const input = document.createElement("input");
  input.type = "date";
  input.value = state.date;
  input.style.position = "fixed";
  input.style.left = "-1000px";
  document.body.appendChild(input);
  input.addEventListener("change", () => {
    if (input.value && /^\d{4}-\d{2}-\d{2}$/.test(input.value)) {
      state.date = input.value;
      reRender();
    }
    input.remove();
  });
  input.focus();
  input.click();
}

// ---------- Journal save/delete ----------

async function saveJournal(entry) {
  store.upsertJournalLocal(state.date, entry);
  paintJournal();
  try {
    showSpinner();
    const saved = await gas.pushMemoUpsert(entry);
    // サーバ確定値で更新
    store.upsertJournalLocal(state.date, saved);
    paintJournal();
    toast("保存しました", "success");
  } catch (e) {
    await outbox.enqueue({ type: "memo_upsert", payload: entry });
    toast("オフライン：送信キューに追加", "warn");
  } finally {
    hideSpinner();
  }
}

async function deleteJournal(id) {
  const list = store.loadJournal(state.date).filter((e) => e.id !== id);
  store.saveJournal(state.date, list);
  paintJournal();
  try {
    showSpinner();
    await gas.pushMemoDelete(id);
    toast("削除しました", "success");
  } catch (e) {
    await outbox.enqueue({ type: "memo_delete", payload: { id: id } });
    toast("オフライン：削除キューに追加", "warn");
  } finally {
    hideSpinner();
  }
}

// ---------- Pull（更新ボタンから呼ばれる） ----------

export async function pullAndRender() {
  showSpinner();
  try {
    await flushOutbox();
    const [events, entries] = await Promise.all([
      gas.pullCalendar(state.date),
      gas.pullMemoJournal(state.date),
    ]);
    store.saveCalendar(state.date, events);
    store.saveJournal(state.date, entries);
    if (rootEl) {
      paintEvents();
      paintTasks();
    }
    toast("最新化しました", "success");
  } catch (e) {
    console.error(e);
    toast("取得に失敗しました: " + e.message, "error");
  } finally {
    hideSpinner();
  }
}

async function flushOutbox() {
  const items = await outbox.listAll();
  for (const item of items) {
    try {
      if (item.op.type === "task_upsert") {
        await gas.pushTaskUpsert(item.op.payload);
      } else if (item.op.type === "task_delete") {
        await gas.pushTaskDelete(item.op.payload.id);
      } else if (item.op.type === "memo_upsert") {
        await gas.pushMemoUpsert(item.op.payload);
      } else if (item.op.type === "memo_delete") {
        await gas.pushMemoDelete(item.op.payload.id);
      }
      await outbox.remove(item.id);
    } catch (e) {
      throw e;
    }
  }
}

// ---------- utils ----------

function cryptoUuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "j-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
