// task.js - Task タブのUI実装
// - 一覧（ステータス別グループ、完了は折りたたみ）
// - フィルタ（ステータス・優先度）
// - 並び替え（期限／優先度／作成順）
// - 新規／編集／削除／完了トグル

import * as store from "./store.js";
import * as gas from "./gas-client.js";
import * as outbox from "./outbox.js";
import { toast, showSpinner, hideSpinner } from "./toast.js";
import { nowJst, todayYmd, dueLabel } from "./date-util.js";

const PRIORITY_LABEL = { high: "高", mid: "中", low: "低" };
const PRIORITY_ORDER = { high: 0, mid: 1, low: 2 };
const STATUS_LABEL = {
  todo: "未着手",
  doing: "進行中",
  done: "完了",
  archived: "アーカイブ",
};

const state = {
  filterStatus: "all", // all | active | done
  filterPriority: "all", // all | high | mid | low
  sortBy: "due", // due | priority | created
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
    renderList();
  });
  container
    .querySelector("#btn-new-task")
    .addEventListener("click", () => openEditor(null));

  renderList();
}

function renderList() {
  if (!rootEl) return;
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

  let html = "";
  if (active.length === 0 && done.length === 0) {
    html = `<p class="empty-hint">タスクはまだありません。右下の＋で追加してください。</p>`;
  } else {
    if (active.length > 0) {
      html += `<section class="task-group"><h2>進行中（${active.length}）</h2><ul class="task-items">`;
      for (const t of active) html += taskItemHtml(t);
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

  listEl.querySelectorAll(".task-item").forEach((el) => {
    const id = el.dataset.id;
    el.querySelector(".task-check").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDone(id);
    });
    el.querySelector(".task-body").addEventListener("click", () => {
      const t = store.loadTasks().find((x) => x.id === id);
      if (t) openEditor(t);
    });
  });
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

function taskItemHtml(t) {
  const checked = t.status === "done";
  const due = t.due_date
    ? `<span class="task-due">${escapeHtml(dueLabel(t.due_date))}（${escapeHtml(t.due_date)}）</span>`
    : "";
  const prClass = `pri-${t.priority || "mid"}`;
  return `
    <li class="task-item ${checked ? "is-done" : ""}" data-id="${escapeHtml(t.id)}">
      <button class="task-check ${checked ? "checked" : ""}" aria-label="完了トグル">${checked ? "✓" : ""}</button>
      <div class="task-body">
        <div class="task-title-row">
          <span class="task-priority ${prClass}">${PRIORITY_LABEL[t.priority] || "中"}</span>
          <span class="task-title">${escapeHtml(t.title)}</span>
        </div>
        ${due}
        ${t.memo ? `<div class="task-memo">${escapeHtml(t.memo)}</div>` : ""}
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
  const next = {
    ...t,
    status: t.status === "done" ? "todo" : "done",
    updated_at: nowJst(),
  };
  await saveTask(next);
}

// ---------- Pull（更新ボタンから呼ばれる） ----------

export async function pullAndRender(sinceYmd) {
  showSpinner();
  try {
    // outbox を先に flush
    await flushOutbox();
    const tasks = await gas.pullTasks(sinceYmd);
    store.mergeTasks(tasks);
    renderList();
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
      }
      await outbox.remove(item.id);
    } catch (e) {
      // 失敗したら残して次回に回す
      throw e;
    }
  }
}
