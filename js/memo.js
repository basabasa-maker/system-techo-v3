// memo.js - Memo タブ
// 仕様書（Memoタブ）通り：
// - 初期表示：Googleカレンダー デイリービュー風の時間軸（1時間ごと区切り、0-24時、48px/時間）
// - ジャーナル／ノート／あとで読む の3種別、色・マークで区別
// - FAB → 種別選択 → 種別別入力モーダル
// - 検索（全文＋種別フィルタ）はリスト形式で結果表示
// - ソート：新しい順／古い順 切替
// - 「取込む」ボタン（3文字）：エントリ単位＋日付単位
// - あとで読む：URL入力→タイトル取得ボタン→保存、チェックボックス→削除確認モーダル

import * as store from "./store.js";
import * as gas from "./gas-client.js";
import * as outbox from "./outbox.js";
import { MEMO_TYPE_DEFS } from "./config.js";
import { toast, showSpinner, hideSpinner } from "./toast.js";
import {
  todayYmd,
  nowJst,
  addDaysYmd,
  formatYmdLong,
  nowQuarter,
  pad2,
} from "./date-util.js";

const HOUR_HEIGHT = 48;
const MIN_TO_PX = HOUR_HEIGHT / 60;

const state = {
  date: todayYmd(),
  viewMode: "timeline", // timeline | search | read_later_list
  filterType: "all", // all | journal | note | read_later
  searchQuery: "",
  sortDesc: true, // 新しい順=true
  searchResults: [],
};

let rootEl = null;

export function renderMemoTab(container) {
  rootEl = container;
  container.innerHTML = `
    <div class="memo-tab">
      <div class="memo-datenav">
        <button class="nav-btn" id="memo-prev" aria-label="前日">◀</button>
        <button class="nav-date" id="memo-date">${formatYmdLong(state.date)}</button>
        <button class="nav-btn" id="memo-next" aria-label="翌日">▶</button>
      </div>
      <div class="memo-controls">
        <div class="memo-search-row">
          <input type="search" id="memo-q" placeholder="検索（本文・タグ）" value="${escapeAttr(state.searchQuery)}" />
          <select id="memo-filter">
            <option value="all">全て</option>
            <option value="journal">ジャーナル</option>
            <option value="note">ノート</option>
            <option value="read_later">あとで読む</option>
          </select>
        </div>
        <div class="memo-action-row">
          <button class="btn-sort" id="memo-sort">${state.sortDesc ? "新しい順" : "古い順"}</button>
          <button class="btn-view" id="memo-view-timeline">時間軸</button>
          <button class="btn-view" id="memo-view-readlater">あとで読む一覧</button>
          <button class="btn-inbox-day" id="memo-inbox-day">本日を取込む</button>
        </div>
      </div>
      <div id="memo-body"></div>
      <button id="btn-new-memo" class="fab" aria-label="新規メモ">＋</button>
    </div>
  `;

  container.querySelector("#memo-filter").value = state.filterType;

  container.querySelector("#memo-prev").addEventListener("click", () => {
    state.date = addDaysYmd(state.date, -1);
    state.viewMode = "timeline";
    state.searchQuery = "";
    reRender();
  });
  container.querySelector("#memo-next").addEventListener("click", () => {
    state.date = addDaysYmd(state.date, 1);
    state.viewMode = "timeline";
    state.searchQuery = "";
    reRender();
  });
  container.querySelector("#memo-date").addEventListener("click", () => {
    openDatePicker();
  });

  const qEl = container.querySelector("#memo-q");
  let searchTimer = null;
  qEl.addEventListener("input", () => {
    state.searchQuery = qEl.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (state.searchQuery.trim()) {
        runSearch();
      } else {
        state.viewMode = "timeline";
        paintBody();
      }
    }, 300);
  });
  container.querySelector("#memo-filter").addEventListener("change", (e) => {
    state.filterType = e.target.value;
    if (state.searchQuery.trim() || state.viewMode === "search") {
      runSearch();
    } else {
      paintBody();
    }
  });
  container.querySelector("#memo-sort").addEventListener("click", () => {
    state.sortDesc = !state.sortDesc;
    container.querySelector("#memo-sort").textContent = state.sortDesc
      ? "新しい順"
      : "古い順";
    paintBody();
  });
  container
    .querySelector("#memo-view-timeline")
    .addEventListener("click", () => {
      state.viewMode = "timeline";
      state.searchQuery = "";
      qEl.value = "";
      paintBody();
    });
  container
    .querySelector("#memo-view-readlater")
    .addEventListener("click", () => {
      state.viewMode = "read_later_list";
      paintBody();
    });
  container.querySelector("#memo-inbox-day").addEventListener("click", () => {
    confirmInboxDay();
  });
  container.querySelector("#btn-new-memo").addEventListener("click", () => {
    openTypePicker();
  });

  paintBody();
  if (state.viewMode === "timeline") {
    scrollToCurrentHour();
  }
}

function reRender() {
  if (!rootEl) return;
  renderMemoTab(rootEl);
}

function paintBody() {
  const bodyEl = rootEl.querySelector("#memo-body");
  if (!bodyEl) return;
  if (state.viewMode === "search") {
    bodyEl.innerHTML = renderSearchList(state.searchResults);
    bindEntryHandlers(bodyEl);
    return;
  }
  if (state.viewMode === "read_later_list") {
    bodyEl.innerHTML = renderReadLaterList();
    bindEntryHandlers(bodyEl);
    return;
  }
  // timeline
  bodyEl.innerHTML = renderTimeline();
  bindEntryHandlers(bodyEl);
}

// ----- Timeline (day view) -----

function renderTimeline() {
  const entries = filterEntriesByType(
    store.loadMemoDay(state.date),
    state.filterType,
  );
  let hourGrid = "";
  for (let h = 0; h <= 24; h++) {
    hourGrid += `<div class="hour-row" style="top:${h * HOUR_HEIGHT}px">
      <span class="hour-label">${pad2(h)}:00</span>
      <div class="hour-line"></div>
    </div>`;
  }

  let blocks = "";
  // hour_slotごとにグループ化して縦積み
  const byHour = {};
  for (const en of entries) {
    const h = parseInt(en.hour_slot, 10);
    const key = isNaN(h) ? "noslot" : String(h);
    if (!byHour[key]) byHour[key] = [];
    byHour[key].push(en);
  }
  for (const key of Object.keys(byHour)) {
    const list = byHour[key].slice();
    list.sort((a, b) => ((a.created_at || "") < (b.created_at || "") ? -1 : 1));
    if (!state.sortDesc) {
      // 古い順の場合も時刻内は作成順
    }
    const h = parseInt(key, 10);
    const baseTop = isNaN(h) ? 0 : h * HOUR_HEIGHT;
    for (let i = 0; i < list.length; i++) {
      const en = list[i];
      const top = baseTop + i * 42 + 2;
      blocks += entryBlockHtml(en, top);
    }
  }

  return `
    <div class="memo-timeline-wrap">
      <div class="memo-timeline">
        ${hourGrid}
        <div class="memo-events-layer">${blocks}</div>
      </div>
    </div>
  `;
}

function entryBlockHtml(en, top) {
  const def = MEMO_TYPE_DEFS[en.entry_type] || MEMO_TYPE_DEFS.note;
  const takenCls = en.claude_taken ? "is-taken" : "";
  const titleText = en.title || (en.entry_type === "read_later" ? en.body : "");
  return `
    <div class="memo-block ${takenCls}" data-id="${escapeAttr(en.id)}" style="top:${top}px;border-left-color:${def.color}">
      <div class="memo-block-main">
        <span class="memo-mark" style="background:${def.color}">${def.mark}</span>
        <span class="memo-block-title">${escapeHtml(titleText || "(無題)")}</span>
        ${en.claude_taken ? '<span class="taken-badge">✓取込済</span>' : ""}
      </div>
      <div class="memo-block-meta">
        ${en.hour_slot !== "" && en.hour_slot != null ? pad2(parseInt(en.hour_slot, 10)) + ":00" : ""}
        ${en.tags ? " / " + escapeHtml(en.tags) : ""}
      </div>
      <button class="btn-take" data-take-id="${escapeAttr(en.id)}">取込む</button>
    </div>
  `;
}

// ----- Search list / Read-later list -----

function renderSearchList(entries) {
  const sorted = sortEntries(entries.slice());
  if (sorted.length === 0) {
    return `<p class="empty-hint">該当するメモはありません。</p>`;
  }
  let h = `<div class="memo-list">`;
  for (const en of sorted) {
    h += memoRowHtml(en);
  }
  h += `</div>`;
  return h;
}

function renderReadLaterList() {
  const notes = store
    .loadMemoNotes()
    .filter((e) => e.entry_type === "read_later" && !e.deleted);
  const sorted = sortEntries(notes);
  if (sorted.length === 0) {
    return `<p class="empty-hint">「あとで読む」はまだありません。</p>`;
  }
  let h = `<div class="memo-list memo-readlater-list">`;
  for (const en of sorted) {
    h += memoRowHtml(en, true);
  }
  h += `</div>`;
  return h;
}

function memoRowHtml(en, showDeleteCheck) {
  const def = MEMO_TYPE_DEFS[en.entry_type] || MEMO_TYPE_DEFS.note;
  const takenCls = en.claude_taken ? "is-taken" : "";
  const titleText = en.title || (en.entry_type === "read_later" ? en.body : "");
  const bodyPreview =
    en.entry_type === "read_later" ? en.body || "" : en.body || "";
  const urlMatch =
    en.entry_type === "read_later"
      ? String(en.body || "").match(/^https?:\/\/\S+/)
      : null;
  const urlLink = urlMatch
    ? `<a class="memo-url" href="${escapeAttr(urlMatch[0])}" target="_blank" rel="noopener">${escapeHtml(urlMatch[0])}</a>`
    : "";
  const checkbox = showDeleteCheck
    ? `<button class="memo-delete-check" data-delete-id="${escapeAttr(en.id)}" aria-label="削除">☐</button>`
    : "";
  return `
    <div class="memo-row ${takenCls}" data-id="${escapeAttr(en.id)}">
      ${checkbox}
      <span class="memo-mark" style="background:${def.color}">${def.mark}</span>
      <div class="memo-row-body">
        <div class="memo-row-title">${escapeHtml(titleText || "(無題)")}</div>
        ${urlLink ? `<div class="memo-row-url">${urlLink}</div>` : ""}
        ${!urlMatch && bodyPreview ? `<div class="memo-row-preview">${escapeHtml(bodyPreview.slice(0, 120))}</div>` : ""}
        <div class="memo-row-meta">
          ${escapeHtml(en.date || "")}
          ${en.hour_slot !== "" && en.hour_slot != null ? " " + pad2(parseInt(en.hour_slot, 10)) + ":00" : ""}
          ${en.tags ? " / " + escapeHtml(en.tags) : ""}
          ${en.claude_taken ? ' <span class="taken-badge-sm">✓取込済</span>' : ""}
        </div>
      </div>
      <button class="btn-take" data-take-id="${escapeAttr(en.id)}">取込む</button>
    </div>
  `;
}

// ----- Filter / sort helpers -----

function filterEntriesByType(entries, filterType) {
  if (!filterType || filterType === "all") return entries;
  return entries.filter((e) => e.entry_type === filterType);
}

function sortEntries(entries) {
  const filtered = filterEntriesByType(entries, state.filterType);
  filtered.sort((a, b) => {
    const ka = a.updated_at || a.created_at || "";
    const kb = b.updated_at || b.created_at || "";
    if (state.sortDesc) return ka < kb ? 1 : ka > kb ? -1 : 0;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return filtered;
}

// ----- Event handlers -----

function bindEntryHandlers(bodyEl) {
  bodyEl.querySelectorAll("[data-id]").forEach((el) => {
    el.addEventListener("click", (e) => {
      // 取込ボタン・削除ボタンは別処理
      if (e.target.closest(".btn-take")) return;
      if (e.target.closest(".memo-delete-check")) return;
      if (e.target.closest(".memo-url")) return;
      const id = el.dataset.id;
      const en = findEntryById(id);
      if (en) openEditor(en);
    });
  });
  bodyEl.querySelectorAll(".btn-take").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.takeId;
      confirmInboxEntry(id);
    });
  });
  bodyEl.querySelectorAll(".memo-delete-check").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.deleteId;
      confirmDeleteEntry(id);
    });
  });
}

function findEntryById(id) {
  const day = store.loadMemoDay(state.date).find((e) => e.id === id);
  if (day) return day;
  const notes = store.loadMemoNotes().find((e) => e.id === id);
  if (notes) return notes;
  const search = state.searchResults.find((e) => e.id === id);
  return search || null;
}

// ----- Type picker (FAB) -----

function openTypePicker() {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <header>種別を選択</header>
      <div class="modal-body">
        <button class="btn-type" data-type="journal" style="background:${MEMO_TYPE_DEFS.journal.color}">📝 ジャーナル</button>
        <button class="btn-type" data-type="note" style="background:${MEMO_TYPE_DEFS.note.color}">📌 ノート</button>
        <button class="btn-type" data-type="read_later" style="background:${MEMO_TYPE_DEFS.read_later.color}">🔖 あとで読む</button>
      </div>
      <footer>
        <div style="flex:1"></div>
        <button class="btn-ghost" id="p-cancel">キャンセル</button>
      </footer>
    </div>`;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector("#p-cancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  modal.querySelectorAll(".btn-type").forEach((btn) => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.type;
      close();
      openEditor(newEntry(type));
    });
  });
}

function newEntry(type) {
  const q = nowQuarter();
  return {
    id: cryptoUuid(),
    entry_type: type,
    date: state.date,
    hour_slot: String(q.hour),
    title: "",
    body: "",
    tags: "",
    created_at: nowJst(),
    updated_at: nowJst(),
    deleted: 0,
    claude_taken: 0,
    _isNew: true,
  };
}

// ----- Editor modal -----

function openEditor(existing) {
  const en = existing;
  const isNew = !!en._isNew;
  const type = en.entry_type;
  const def = MEMO_TYPE_DEFS[type] || MEMO_TYPE_DEFS.note;

  const hourOptions = [
    `<option value="">（時刻なし）</option>`,
    ...Array.from({ length: 24 }, (_, i) => {
      const sel = String(i) === String(en.hour_slot) ? "selected" : "";
      return `<option value="${i}" ${sel}>${pad2(i)}:00</option>`;
    }),
  ].join("");

  let bodyHtml = "";
  if (type === "journal") {
    bodyHtml = `
      <label>時間帯
        <select id="m-hour">${hourOptions}</select>
      </label>
      <label>タイトル（任意）
        <input type="text" id="m-title" value="${escapeAttr(en.title || "")}" autocomplete="off" />
      </label>
      <label>本文（必須）
        <textarea id="m-body" rows="5">${escapeHtml(en.body || "")}</textarea>
      </label>
    `;
  } else if (type === "note") {
    bodyHtml = `
      <label>時間帯（任意）
        <select id="m-hour">${hourOptions}</select>
      </label>
      <label>タイトル
        <input type="text" id="m-title" value="${escapeAttr(en.title || "")}" autocomplete="off" />
      </label>
      <label>本文
        <textarea id="m-body" rows="5">${escapeHtml(en.body || "")}</textarea>
      </label>
      <label>タグ（カンマ区切り）
        <input type="text" id="m-tags" value="${escapeAttr(en.tags || "")}" autocomplete="off" />
      </label>
    `;
  } else {
    // read_later
    const existingUrl = extractUrlFromBody(en.body || "");
    bodyHtml = `
      <label>URL（必須）
        <input type="url" id="m-url" value="${escapeAttr(existingUrl)}" autocomplete="off" placeholder="https://…" />
      </label>
      <button class="btn-ghost" id="m-fetch">タイトル取得</button>
      <label>タイトル
        <input type="text" id="m-title" value="${escapeAttr(en.title || "")}" autocomplete="off" />
      </label>
      <label>タグ（任意）
        <input type="text" id="m-tags" value="${escapeAttr(en.tags || "")}" autocomplete="off" />
      </label>
    `;
  }

  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <header><span class="memo-mark" style="background:${def.color}">${def.mark}</span> ${isNew ? "新規" : "編集"}：${def.label}</header>
      <div class="modal-body">${bodyHtml}</div>
      <footer>
        ${isNew ? "" : '<button class="btn-danger" id="m-delete">削除</button>'}
        <div style="flex:1"></div>
        <button class="btn-ghost" id="m-cancel">キャンセル</button>
        <button class="btn-primary" id="m-save">保存</button>
      </footer>
    </div>`;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector("#m-cancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });

  if (type === "read_later") {
    modal.querySelector("#m-fetch").addEventListener("click", async () => {
      const url = modal.querySelector("#m-url").value.trim();
      if (!url) {
        toast("URLを入力してください", "error");
        return;
      }
      showSpinner();
      try {
        const res = await gas.fetchUrlTitle(url);
        if (res && res.title) {
          modal.querySelector("#m-title").value = res.title;
          toast("タイトルを取得しました", "success");
        } else {
          toast("取得失敗：手入力してください", "warn");
        }
      } catch (err) {
        toast("取得失敗：" + err.message, "error");
      } finally {
        hideSpinner();
      }
    });
  }

  modal.querySelector("#m-save").addEventListener("click", async () => {
    const updated = { ...en };
    updated._isNew = undefined;
    if (type === "journal") {
      const body = modal.querySelector("#m-body").value.trim();
      if (!body) {
        toast("本文を入力してください", "error");
        return;
      }
      updated.hour_slot = modal.querySelector("#m-hour").value;
      updated.title = modal.querySelector("#m-title").value.trim();
      updated.body = body;
    } else if (type === "note") {
      const title = modal.querySelector("#m-title").value.trim();
      const body = modal.querySelector("#m-body").value.trim();
      if (!title && !body) {
        toast("タイトルか本文を入力してください", "error");
        return;
      }
      updated.hour_slot = modal.querySelector("#m-hour").value;
      updated.title = title;
      updated.body = body;
      updated.tags = modal.querySelector("#m-tags").value.trim();
    } else {
      const url = modal.querySelector("#m-url").value.trim();
      if (!url) {
        toast("URLを入力してください", "error");
        return;
      }
      if (!/^https?:\/\//i.test(url)) {
        toast("http / https のURLを入力してください", "error");
        return;
      }
      updated.title = modal.querySelector("#m-title").value.trim();
      updated.tags = modal.querySelector("#m-tags").value.trim();
      updated.body = url;
      // hour_slot はデフォルト（現在時刻）のまま
    }
    updated.updated_at = nowJst();
    updated.deleted = 0;
    close();
    await saveEntry(updated);
  });

  const delBtn = modal.querySelector("#m-delete");
  if (delBtn) {
    delBtn.addEventListener("click", async () => {
      close();
      confirmDeleteEntry(en.id);
    });
  }
}

function extractUrlFromBody(body) {
  const m = String(body || "").match(/^https?:\/\/\S+/);
  return m ? m[0] : "";
}

// ----- Save / Delete / Inbox -----

async function saveEntry(entry) {
  // ローカルキャッシュに即時反映
  if (entry.date === state.date) {
    store.upsertMemoDayLocal(state.date, entry);
  }
  const notes = store.loadMemoNotes();
  const idx = notes.findIndex((e) => e.id === entry.id);
  if (idx >= 0) notes[idx] = entry;
  else notes.unshift(entry);
  store.saveMemoNotes(notes);
  paintBody();

  try {
    showSpinner();
    const saved = await gas.pushMemoUpsert(entry);
    // サーバ確定値で上書き
    if (saved.date === state.date) {
      store.upsertMemoDayLocal(state.date, saved);
    }
    const notes2 = store.loadMemoNotes();
    const idx2 = notes2.findIndex((e) => e.id === saved.id);
    if (idx2 >= 0) notes2[idx2] = saved;
    else notes2.unshift(saved);
    store.saveMemoNotes(notes2);
    paintBody();
    toast("保存しました", "success");
  } catch (e) {
    await outbox.enqueue({ type: "memo_upsert", payload: entry });
    toast("オフライン：送信キューに追加", "warn");
  } finally {
    hideSpinner();
  }
}

function confirmDeleteEntry(id) {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <header>削除の確認</header>
      <div class="modal-body">
        <p>削除してよいですか？</p>
      </div>
      <footer>
        <div style="flex:1"></div>
        <button class="btn-ghost" id="d-cancel">キャンセル</button>
        <button class="btn-danger" id="d-ok">削除する</button>
      </footer>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector("#d-cancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  modal.querySelector("#d-ok").addEventListener("click", async () => {
    close();
    await deleteEntry(id);
  });
}

async function deleteEntry(id) {
  store.deleteMemoDayLocal(state.date, id);
  const notes = store.loadMemoNotes().filter((e) => e.id !== id);
  store.saveMemoNotes(notes);
  state.searchResults = state.searchResults.filter((e) => e.id !== id);
  paintBody();
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

function confirmInboxEntry(id) {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <header>Claudeに取込む</header>
      <div class="modal-body">
        <p>このエントリを取込済みとしてマークしますか？</p>
      </div>
      <footer>
        <div style="flex:1"></div>
        <button class="btn-ghost" id="i-cancel">キャンセル</button>
        <button class="btn-primary" id="i-ok">取込む</button>
      </footer>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector("#i-cancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  modal.querySelector("#i-ok").addEventListener("click", async () => {
    close();
    await inboxEntry(id);
  });
}

function confirmInboxDay() {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <header>この日を一括取込</header>
      <div class="modal-body">
        <p>${escapeHtml(state.date)} の全エントリを取込済みにしますか？</p>
      </div>
      <footer>
        <div style="flex:1"></div>
        <button class="btn-ghost" id="id-cancel">キャンセル</button>
        <button class="btn-primary" id="id-ok">取込む</button>
      </footer>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector("#id-cancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
  modal.querySelector("#id-ok").addEventListener("click", async () => {
    close();
    await inboxDay();
  });
}

async function inboxEntry(id) {
  try {
    showSpinner();
    const res = await gas.pushMemoInboxWrite(id, "");
    // ローカルキャッシュに反映
    markTakenLocal(id);
    paintBody();
    toast(`取込みました（${res.taken || 0}件）`, "success");
  } catch (e) {
    toast("取込失敗：" + e.message, "error");
  } finally {
    hideSpinner();
  }
}

async function inboxDay() {
  try {
    showSpinner();
    const res = await gas.pushMemoInboxWrite("", state.date);
    const day = store.loadMemoDay(state.date);
    for (const en of day) {
      en.claude_taken = 1;
    }
    store.saveMemoDay(state.date, day);
    paintBody();
    toast(`取込みました（${res.taken || 0}件）`, "success");
  } catch (e) {
    toast("取込失敗：" + e.message, "error");
  } finally {
    hideSpinner();
  }
}

function markTakenLocal(id) {
  const day = store.loadMemoDay(state.date);
  const t = day.find((e) => e.id === id);
  if (t) {
    t.claude_taken = 1;
    store.saveMemoDay(state.date, day);
  }
  const notes = store.loadMemoNotes();
  const n = notes.find((e) => e.id === id);
  if (n) {
    n.claude_taken = 1;
    store.saveMemoNotes(notes);
  }
  const s = state.searchResults.find((e) => e.id === id);
  if (s) s.claude_taken = 1;
}

// ----- Search -----

async function runSearch() {
  state.viewMode = "search";
  showSpinner();
  try {
    const res = await gas.pullMemoSearch(state.searchQuery, state.filterType);
    state.searchResults = res.entries || [];
    paintBody();
  } catch (e) {
    toast("検索失敗：" + e.message, "error");
  } finally {
    hideSpinner();
  }
}

// ----- Pull -----

export async function pullAndRender() {
  showSpinner();
  try {
    await flushOutbox();
    const [day, notesRes] = await Promise.all([
      gas.pullMemoDay(state.date),
      gas.pullMemoNotes(100, 0),
    ]);
    store.saveMemoDay(state.date, day);
    store.saveMemoNotes(notesRes.entries || []);
    paintBody();
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
      if (item.op.type === "memo_upsert") {
        await gas.pushMemoUpsert(item.op.payload);
      } else if (item.op.type === "memo_delete") {
        await gas.pushMemoDelete(item.op.payload.id);
      } else {
        // 他タイプはスキップ（他タブのflushに任せる）
        continue;
      }
      await outbox.remove(item.id);
    } catch (e) {
      throw e;
    }
  }
}

// ----- utils -----

function scrollToCurrentHour() {
  const wrap = rootEl.querySelector(".memo-timeline-wrap");
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

function openDatePicker() {
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

function cryptoUuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "m-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s) {
  return escapeHtml(s);
}
