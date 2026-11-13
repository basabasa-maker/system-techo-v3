// task.js - Task タブのUI実装
// - 一覧（ステータス別グループ、完了は折りたたみ）
// - フィルタ（ステータス・優先度）
// - 並び替え（期限／優先度／作成順／手動）
// - 行の長押しで上下に移動（手動並びに切り替わる）、右スワイプでピン留め
// - 新規／編集／削除／完了トグル

import * as store from "./store.js";
import * as sync from "./sync.js";
import * as gas from "./gas-client.js";
import * as outbox from "./outbox.js";
import { toast, showSpinner, hideSpinner } from "./toast.js";
import { nowJst, todayYmd, dueLabel } from "./date-util.js";
import { enableLongPressReorder, justDragged } from "./reorder.js";
import { LS_KEY_TASK_SORT } from "./config.js";

const PRIORITY_LABEL = { high: "高", mid: "中", low: "低" };
const PRIORITY_ORDER = { high: 0, mid: 1, low: 2 };
const STATUS_LABEL = {
  todo: "未着手",
  doing: "進行中",
  adjusting: "調整中",
  done: "完了",
  archived: "アーカイブ",
};

// 並び方は端末に覚えておく（アプリを開き直したとき、手動の並びが期限順に戻らないように）
function loadSortBy() {
  try {
    const v = localStorage.getItem(LS_KEY_TASK_SORT);
    if (["due", "priority", "created", "manual"].includes(v)) return v;
  } catch (_) {}
  return "due";
}
function saveSortBy(v) {
  try {
    localStorage.setItem(LS_KEY_TASK_SORT, v);
  } catch (_) {}
}

const state = {
  filterStatus: "all", // all | active | done
  filterPriority: "all", // all | high | mid | low
  sortBy: loadSortBy(), // due | priority | created | manual
  doneCollapsed: true,
};

let rootEl = null;

export function renderTaskTab(container) {
  rootEl = container;
  container.innerHTML = `
    <div class="task-tab">
      <div class="task-controls">
        <div class="task-filter-row">
          <label>状態
            <select id="f-status">
              <option value="all">全て</option>
              <option value="active">進行中</option>
              <option value="done">完了</option>
            </select>
          </label>
          <label>優先度
            <select id="f-priority">
              <option value="all">全て</option>
              <option value="high">高</option>
              <option value="mid">中</option>
              <option value="low">低</option>
            </select>
          </label>
          <label>並び
            <select id="f-sort">
              <option value="due">期限</option>
              <option value="priority">優先度</option>
              <option value="created">作成順</option>
              <option value="manual">手動</option>
            </select>
          </label>
        </div>
      </div>
      <div id="task-list"></div>
      <button id="btn-new-task" class="fab" aria-label="新規タスク">＋</button>
    </div>
  `;

  container.querySelector("#f-status").value = state.filterStatus;
  container.querySelector("#f-priority").value = state.filterPriority;
  container.querySelector("#f-sort").value = state.sortBy;

  container.querySelector("#f-status").addEventListener("change", (e) => {
    state.filterStatus = e.target.value;
    renderList();
  });
  container.querySelector("#f-priority").addEventListener("change", (e) => {
    state.filterPriority = e.target.value;
    renderList();
  });
  container.querySelector("#f-sort").addEventListener("change", (e) => {
    state.sortBy = e.target.value;
    saveSortBy(state.sortBy);
    renderList();
  });
  container
    .querySelector("#btn-new-task")
    .addEventListener("click", () => openEditor(null));

  renderList();
}

function renderList() {
  if (!rootEl?.isConnected) return;
  const listEl = rootEl.querySelector("#task-list");
  if (!listEl) return;
  const tasks = store.loadTasks().filter((t) => !t.deleted);

  const filtered = tasks.filter((t) => {
    if (state.filterPriority !== "all" && t.priority !== state.filterPriority) {
      return false;
    }
    if (state.filterStatus === "active") {
      return t.status !== "done" && t.status !== "archived";
    }
    if (state.filterStatus === "done") {
      return t.status === "done";
    }
    return true;
  });

  const active = filtered.filter(
    (t) => t.status !== "done" && t.status !== "archived",
  );
  const done = filtered.filter((t) => t.status === "done");

  sortInPlace(active);
  sortInPlace(done);
  // 今日が期限（期限切れも含む）の未完了タスクは、先頭の枠にまとめる
  const today = todayYmd();
  const isToday = (t) =>
    /^\d{4}-\d{2}-\d{2}$/.test(t.due_date || "") && t.due_date <= today;
  const todays = active.filter(isToday);
  const rest = active.filter((t) => !isToday(t));
  const pinned = rest.filter((t) => t.pinned);
  const unpinned = rest.filter((t) => !t.pinned);

  let html = "";
  if (active.length === 0 && done.length === 0) {
    html = `<p class="empty-hint">タスクはまだありません。右下の＋で追加してください。</p>`;
  } else {
    if (todays.length > 0) {
      html += `<section class="task-group task-today"><h2>🔥 今日やること（${todays.length}）</h2><ul class="task-items" data-group="today">`;
      for (const t of todays) html += taskItemHtml(t);
      html += `</ul></section>`;
    }
    if (pinned.length > 0) {
      html += `<section class="task-group"><h2>📌 ピン留め（${pinned.length}）</h2><ul class="task-items" data-group="pinned">`;
      for (const t of pinned) html += taskItemHtml(t);
      html += `</ul></section>`;
    }
    if (unpinned.length > 0) {
      html += `<section class="task-group"><h2>進行中（${unpinned.length}）</h2><ul class="task-items" data-group="active">`;
      for (const t of unpinned) html += taskItemHtml(t);
      html += `</ul></section>`;
    }
    if (done.length > 0) {
      const arrow = state.doneCollapsed ? "▶" : "▼";
      html += `<section class="task-group"><h2 id="done-header" role="button" tabindex="0">${arrow} 完了（${done.length}）</h2>`;
      if (!state.doneCollapsed) {
        html += `<ul class="task-items">`;
        for (const t of done) html += taskItemHtml(t);
        html += `</ul>`;
      }
      html += `</section>`;
    }
  }
  listEl.innerHTML = html;

  const doneHeader = listEl.querySelector("#done-header");
  if (doneHeader) {
    doneHeader.addEventListener("click", () => {
      state.doneCollapsed = !state.doneCollapsed;
      renderList();
    });
  }

  listEl.querySelectorAll(".task-item-wrap").forEach((wrap) => {
    const row = wrap.querySelector(".task-item");
    const id = wrap.dataset.id;

    // チェック（完了トグル）→ 確認ダイアログ
    wrap.querySelector(".task-check").addEventListener("click", (e) => {
      e.stopPropagation();
      if (isSwipedOrSwiping(wrap)) {
        resetAllTaskSwipes();
        return;
      }
      toggleDone(id);
    });

    // 本文タップ → 編集モーダル
    wrap.querySelector(".task-body").addEventListener("click", () => {
      if (justDragged()) return;
      if (isSwipedOrSwiping(wrap)) {
        resetAllTaskSwipes();
        return;
      }
      const t = store.loadTasks().find((x) => x.id === id);
      if (t) openEditor(t);
    });

    // 削除アクションボタン
    wrap.querySelector(".task-row-del").addEventListener("click", (e) => {
      e.stopPropagation();
      resetAllTaskSwipes();
      confirmDeleteTask(id);
    });

    // スワイプ（左で削除ボタン露出、右でピン留め切替）
    bindTaskSwipe(wrap, row);
  });

  // 長押しで上下に移動。ピン留めと通常は別の列なので、列の中だけで入れ替える
  listEl.querySelectorAll("ul.task-items[data-group]").forEach((ul) => {
    enableLongPressReorder(ul, {
      itemSelector: ".task-item-wrap",
      onReorder: onReorderTasks,
    });
  });
}

// 並べ替え結果を sort_order に保存する（変わった行だけ1件ずつ送信）
async function onReorderTasks(ids) {
  const all = store.loadTasks();
  const byId = new Map(all.map((t) => [t.id, t]));
  const changed = [];
  ids.forEach((id, i) => {
    const t = byId.get(id);
    if (!t) return;
    const order = (i + 1) * 10;
    if (Number(t.sort_order) !== order) {
      const next = { ...t, sort_order: order, updated_at: nowJst() };
      store.upsertLocal(next);
      changed.push(next);
    }
  });
  state.sortBy = "manual";
  saveSortBy("manual");
  const sel = rootEl && rootEl.querySelector("#f-sort");
  if (sel) sel.value = "manual";
  renderList();
  // 送信は、まず送信待ちに入れてから送る。
  // 送っている途中で更新が走っても、アプリを閉じても、手元の並びが古い値に巻き戻らない
  for (const t of changed) await outbox.enqueue({ type: "task_upsert", payload: t });
  const failed = await sync.flushAll();
  if (failed > 0) toast("オフライン：送信待ちに入れました", "warn");
}

async function togglePin(id) {
  const t = store.loadTasks().find((x) => x.id === id);
  if (!t) return;
  const next = { ...t, pinned: t.pinned ? 0 : 1, updated_at: nowJst() };
  store.upsertLocal(next);
  renderList();
  await pushTask(next);
  toast(next.pinned ? "ピン留めしました" : "ピン留めを外しました", "success");
}

// 画面を止めずに1件送る。失敗したら送信キューへ
async function pushTask(task) {
  try {
    await gas.pushTaskUpsert(task);
  } catch (e) {
    await outbox.enqueue({ type: "task_upsert", payload: task });
    toast("オフライン：送信キューに追加", "warn");
  }
}

function isSwipedOrSwiping(wrap) {
  return (
    wrap.classList.contains("swiping") || wrap.classList.contains("swiped-left")
  );
}

function resetAllTaskSwipes(exceptWrap) {
  if (!rootEl?.isConnected) return;
  rootEl.querySelectorAll(".task-item-wrap").forEach((w) => {
    if (w === exceptWrap) return;
    const r = w.querySelector(".task-item");
    if (r) r.style.transform = "";
    w.classList.remove("swiping", "swiped-left");
  });
}

function bindTaskSwipe(wrap, row) {
  let startX = 0,
    startY = 0,
    dx = 0,
    active = false,
    locked = null; // null=未決定 / "h"=横スワイプ / "v"=縦スクロール
  const THRESHOLD = 60;
  row.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      resetAllTaskSwipes(wrap);
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      dx = 0;
      active = true;
      locked = null;
      wrap.classList.add("swiping");
      row.style.transition = "none";
    },
    { passive: true },
  );
  row.addEventListener(
    "touchmove",
    (e) => {
      if (!active) return;
      const diffX = e.touches[0].clientX - startX;
      const diffY = e.touches[0].clientY - startY;
      // 動き始めの10pxは縦か横か決めない（縦スクロール中に行が横へ揺れるのを防ぐ）
      if (locked === null) {
        if (Math.max(Math.abs(diffX), Math.abs(diffY)) < 10) return;
        locked = Math.abs(diffX) > Math.abs(diffY) * 1.5 ? "h" : "v";
      }
      if (locked === "v") {
        active = false;
        wrap.classList.remove("swiping");
        row.style.transform = "";
        return;
      }
      dx = diffX;
      // 左は削除ボタン露出、右はピン留め（途中まで引き出せる）
      const clamped = Math.min(100, Math.max(-140, dx));
      row.style.transform = `translateX(${clamped}px)`;
    },
    { passive: true },
  );
  row.addEventListener("touchend", () => {
    if (!active) return;
    active = false;
    row.style.transition = "";
    wrap.classList.remove("swiping");
    if (dx <= -THRESHOLD) {
      row.style.transform = "translateX(-100px)";
      wrap.classList.add("swiped-left");
    } else if (dx >= THRESHOLD && !justDragged()) {
      row.style.transform = "";
      togglePin(wrap.dataset.id);
    } else {
      row.style.transform = "";
    }
  });
}

function confirmDeleteTask(id) {
  const t = store.loadTasks().find((x) => x.id === id);
  if (!t) return;
  if (!confirm(`「${t.title}」を削除しますか？\nこの操作は取り消せません。`))
    return;
  deleteTask(id);
}

function sortInPlace(arr) {
  const cmp = {
    due: (a, b) => {
      const ad = a.due_date || "9999-99-99";
      const bd = b.due_date || "9999-99-99";
      if (ad !== bd) return ad < bd ? -1 : 1;
      return (
        (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1)
      );
    },
    priority: (a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 1;
      const pb = PRIORITY_ORDER[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      return (a.due_date || "9999-99-99") < (b.due_date || "9999-99-99")
        ? -1
        : 1;
    },
    created: (a, b) => ((a.created_at || "") < (b.created_at || "") ? 1 : -1),
    // 手動: 長押しで決めた順。未設定のものは末尾（作成の新しい順）
    manual: store.compareTasksManual,
  }[state.sortBy];
  arr.sort(cmp);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STATUS_VIEW = {
  todo: "○ 未着手",
  doing: "◐ 進行中",
  adjusting: "◔ 調整中",
  done: "● 完了",
  archived: "▣ 保管",
};

function taskItemHtml(t) {
  const checked = t.status === "done";
  // due_dateが正しい形式(YYYY-MM-DD)の時のみ表示
  const dueValid = /^\d{4}-\d{2}-\d{2}$/.test(t.due_date || "");
  const due = dueValid
    ? `<span class="task-due">${escapeHtml(dueLabel(t.due_date))}（${escapeHtml(t.due_date)}）</span>`
    : "";
  const prClass = `pri-${t.priority || "mid"}`;
  const st = STATUS_VIEW[t.status] || STATUS_VIEW.todo;
  return `
    <li class="task-item-wrap st-${t.status in STATUS_VIEW ? t.status : "todo"}" data-id="${escapeHtml(t.id)}">
      <div class="task-row-pinhint">${t.pinned ? "解除" : "📌"}</div>
      <div class="task-row-action task-row-del" data-action="del">削除</div>
      <div class="task-item ${checked ? "is-done" : ""}" data-id="${escapeHtml(t.id)}">
        <button class="task-check ${checked ? "checked" : ""}" aria-label="完了トグル">${checked ? "✓" : ""}</button>
        <div class="task-body">
          <div class="task-title-row">
            <span class="task-priority ${prClass}">${PRIORITY_LABEL[t.priority] || "中"}</span>
            <span class="task-status task-status-${t.status in STATUS_VIEW ? t.status : "todo"}">${st}</span>
            <span class="task-title">${escapeHtml(t.title)}</span>
          </div>
          ${due}
          ${t.memo ? `<div class="task-memo">${escapeHtml(t.memo)}</div>` : ""}
        </div>
      </div>
    </li>`;
}

// ---------- Editor Modal ----------

function openEditor(existing) {
  const isNew = !existing;
  const t = existing || {
    id: cryptoUuid(),
    title: "",
    status: "todo",
    due_date: "",
    priority: "mid",
    tags: "",
    source: "iphone",
    memo: "",
    created_at: nowJst(),
    updated_at: nowJst(),
    deleted: 0,
  };

  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <header>${isNew ? "新規タスク" : "タスク編集"}</header>
      <div class="modal-body">
        <label>タイトル
          <input type="text" id="m-title" value="${escapeHtml(t.title)}" autocomplete="off" />
        </label>
        <label>メモ
          <textarea id="m-memo" rows="3">${escapeHtml(t.memo)}</textarea>
        </label>
        <label>期限
          <input type="date" id="m-due" value="${escapeHtml(t.due_date)}" />
        </label>
        <label>優先度
          <select id="m-priority">
            <option value="high">高</option>
            <option value="mid">中</option>
            <option value="low">低</option>
          </select>
        </label>
        <label>ステータス
          <select id="m-status">
            <option value="todo">未着手</option>
            <option value="doing">進行中</option>
            <option value="adjusting">調整中</option>
            <option value="done">完了</option>
            <option value="archived">アーカイブ</option>
          </select>
        </label>
      </div>
      <footer>
        ${isNew ? "" : '<button class="btn-danger" id="m-delete">削除</button>'}
        <div style="flex:1"></div>
        <button class="btn-ghost" id="m-cancel">キャンセル</button>
        <button class="btn-primary" id="m-save">保存</button>
      </footer>
    </div>`;
  document.body.appendChild(modal);

  modal.querySelector("#m-priority").value = t.priority;
  modal.querySelector("#m-status").value = t.status;

  const close = () => modal.remove();
  modal.querySelector("#m-cancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });

  modal.querySelector("#m-save").addEventListener("click", async () => {
    const title = modal.querySelector("#m-title").value.trim();
    if (!title) {
      toast("タイトルを入力してください", "error");
      return;
    }
    const updated = {
      ...t,
      title: title,
      memo: modal.querySelector("#m-memo").value,
      due_date: modal.querySelector("#m-due").value || "",
      priority: modal.querySelector("#m-priority").value,
      status: modal.querySelector("#m-status").value,
      updated_at: nowJst(),
      deleted: 0,
    };
    close();
    await saveTask(updated);
  });

  const delBtn = modal.querySelector("#m-delete");
  if (delBtn) {
    delBtn.addEventListener("click", async () => {
      if (!confirm("このタスクを削除しますか？")) return;
      close();
      await deleteTask(t.id);
    });
  }

  setTimeout(() => modal.querySelector("#m-title").focus(), 50);
}

function cryptoUuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // フォールバック
  return "t-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

async function saveTask(task) {
  store.upsertLocal(task);
  renderList();
  try {
    showSpinner();
    await gas.pushTaskUpsert(task);
    toast("保存しました", "success");
  } catch (e) {
    await outbox.enqueue({ type: "task_upsert", payload: task });
    toast("オフライン：送信キューに追加", "warn");
  } finally {
    hideSpinner();
  }
}

async function deleteTask(id) {
  store.deleteLocal(id);
  renderList();
  try {
    showSpinner();
    await gas.pushTaskDelete(id);
    toast("削除しました", "success");
  } catch (e) {
    await outbox.enqueue({ type: "task_delete", payload: { id: id } });
    toast("オフライン：削除キューに追加", "warn");
  } finally {
    hideSpinner();
  }
}

async function toggleDone(id) {
  const list = store.loadTasks();
  const t = list.find((x) => x.id === id);
  if (!t) return;
  const willComplete = t.status !== "done";
  const msg = willComplete
    ? `「${t.title}」を完了にしますか？`
    : `「${t.title}」を未完了に戻しますか？`;
  if (!confirm(msg)) return;
  const next = {
    ...t,
    status: willComplete ? "done" : "todo",
    updated_at: nowJst(),
  };
  await saveTask(next);
}

// ---------- Pull（更新ボタンから呼ばれる） ----------

export async function pullAndRender(sinceYmd, quiet = false) {
  if (!quiet) showSpinner();
  try {
    // outbox を先に flush
    await flushOutbox().catch(() => {}); // 送信待ちが詰まっていても、取得は続ける
    const tasks = await gas.pullTasks("");
    store.mergeTasks(tasks, await sync.pendingKeys());
    renderList();
    if (!quiet) toast("最新化しました" + (await sync.pendingNote()), "success");
  } catch (e) {
    console.error(e);
    if (!quiet) toast("取得に失敗しました: " + e.message, "error");
  } finally {
    if (!quiet) hideSpinner();
  }
}

async function flushOutbox() {
  return sync.flushAll();
}
