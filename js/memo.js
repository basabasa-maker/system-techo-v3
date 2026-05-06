// memo.js - Memo タブ（iPhoneメモアプリ風リスト形式）
// 仕様書 Sprint 3 再実装版：
// - 縦スクロールのリスト、日付でグループ化（今日／昨日／YYYY-MM-DD）
// - ソート切替（新しい順/古い順）、種別フィルタ、全文検索
// - 右スワイプ → ピン留め / 左スワイプ → 削除
// - ピン留めは各日付グループ内で上位
// - 行タップで詳細画面（全画面遷移）
// - FAB → 種別選択 → 種別別入力モーダル

import * as store from "./store.js";
import * as gas from "./gas-client.js";
import * as outbox from "./outbox.js";
import { MEMO_TYPE_DEFS } from "./config.js";
import { toast, showSpinner, hideSpinner } from "./toast.js";
import { todayYmd, nowJst, addDaysYmd, parseHhMm } from "./date-util.js";

const state = {
  filterType: "all", // all | journal | note | read_later
  searchQuery: "",
  sortDesc: true,
  view: "list", // list | detail
  detailId: null,
};

let rootEl = null;
let swipeCtx = null; // 現在スワイプ中の行情報

export function renderMemoTab(container) {
  rootEl = container;
  paintRoot();
}

function paintRoot() {
  if (!rootEl) return;
  if (state.view === "detail") {
    rootEl.innerHTML = renderDetail();
    bindDetail();
    return;
  }
  rootEl.innerHTML = `
    <div class="memo-tab">
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
        </div>
      </div>
      <div id="memo-body"></div>
      <button id="btn-new-memo" class="fab" aria-label="新規メモ">＋</button>
    </div>
  `;
  rootEl.querySelector("#memo-filter").value = state.filterType;
  bindList();
  paintBody();
}

function bindList() {
  const qEl = rootEl.querySelector("#memo-q");
  let t = null;
  qEl.addEventListener("input", () => {
    state.searchQuery = qEl.value;
    clearTimeout(t);
    t = setTimeout(paintBody, 200);
  });
  rootEl.querySelector("#memo-filter").addEventListener("change", (e) => {
    state.filterType = e.target.value;
    paintBody();
  });
  rootEl.querySelector("#memo-sort").addEventListener("click", () => {
    state.sortDesc = !state.sortDesc;
    rootEl.querySelector("#memo-sort").textContent = state.sortDesc
      ? "新しい順"
      : "古い順";
    paintBody();
  });
  rootEl
    .querySelector("#btn-new-memo")
    .addEventListener("click", openTypePicker);
}

// ---------- List body ----------

function paintBody() {
  const bodyEl = rootEl.querySelector("#memo-body");
  if (!bodyEl) return;
  const all = store.loadMemoAll();
  const needle = state.searchQuery.trim().toLowerCase();
  const filtered = all.filter((e) => {
    if (e.deleted) return false;
    if (state.filterType !== "all" && e.entry_type !== state.filterType)
      return false;
    if (needle) {
      const hay = (
        String(e.title || "") +
        "\n" +
        String(e.body || "") +
        "\n" +
        String(e.tags || "")
      ).toLowerCase();
      if (hay.indexOf(needle) < 0) return false;
    }
    return true;
  });
  if (filtered.length === 0) {
    bodyEl.innerHTML = `<p class="empty-hint">メモはまだありません。</p>`;
    return;
  }
  // 日付グループ化
  const groups = {};
  const order = [];
  for (const en of filtered) {
    const d = en.date || extractDateFromCreated(en.created_at) || "";
    if (!groups[d]) {
      groups[d] = [];
      order.push(d);
    }
    groups[d].push(en);
  }
  order.sort((a, b) => (state.sortDesc ? (a < b ? 1 : -1) : a < b ? -1 : 1));
  let html = `<div class="memo-list">`;
  for (const d of order) {
    const list = groups[d];
    // pinned を先頭、以降は時刻で
    list.sort((a, b) => {
      const pa = a.pinned ? 1 : 0;
      const pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      const ka = a.created_at || "";
      const kb = b.created_at || "";
      if (state.sortDesc) return ka < kb ? 1 : ka > kb ? -1 : 0;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    html += `<div class="memo-date-header">${escapeHtml(dateGroupLabel(d))}</div>`;
    for (const en of list) {
      html += memoRowHtml(en);
    }
  }
  html += `</div>`;
  bodyEl.innerHTML = html;
  bindRowEvents(bodyEl);
}

function memoRowHtml(en) {
  const def = MEMO_TYPE_DEFS[en.entry_type] || MEMO_TYPE_DEFS.note;
  const hhmm = extractHhMmFromCreated(en.created_at);
  const title =
    en.title ||
    (en.entry_type === "read_later"
      ? firstLine(en.body)
      : firstLine(en.body)) ||
    "(無題)";
  const preview = firstLine(en.body || "", 80);
  const pinIcon = en.pinned ? `<span class="memo-pin-icon">📌</span>` : "";
  const claudeBadge = isClaudeTaken(en)
    ? `<span class="memo-claude-badge" title="Claude取込み済み">✓Claude</span>`
    : "";
  return `
    <div class="memo-row-wrap" data-id="${escapeAttr(en.id)}">
      <div class="memo-row-action memo-row-pin" data-action="pin">${en.pinned ? "ピン解除" : "ピン留め"}</div>
      <div class="memo-row-action memo-row-del" data-action="del">削除</div>
      <div class="memo-row" data-id="${escapeAttr(en.id)}">
        <div class="memo-type-bar" style="background:${def.color}"></div>
        <div class="memo-row-inner">
          <div class="memo-row-head">
            ${pinIcon}
            <span class="memo-row-time">${escapeHtml(hhmm)}</span>
            <span class="memo-row-title">${escapeHtml(title)}</span>
            ${claudeBadge}
          </div>
          ${preview && preview !== title ? `<div class="memo-row-preview">${escapeHtml(preview)}</div>` : ""}
        </div>
      </div>
    </div>
  `;
}

function isClaudeTaken(en) {
  const v = en && en.claude_taken;
  if (v === 1 || v === true) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "1" || s === "true";
  }
  return false;
}

function bindRowEvents(bodyEl) {
  const wraps = bodyEl.querySelectorAll(".memo-row-wrap");
  wraps.forEach((wrap) => {
    const row = wrap.querySelector(".memo-row");
    const id = wrap.dataset.id;

    // クリック（タップ）→ 詳細画面
    row.addEventListener("click", (e) => {
      // スワイプ中なら無視
      if (
        wrap.classList.contains("swiping") ||
        wrap.classList.contains("swiped-left") ||
        wrap.classList.contains("swiped-right")
      ) {
        e.preventDefault();
        resetAllSwipes();
        return;
      }
      state.view = "detail";
      state.detailId = id;
      paintRoot();
    });

    // アクションボタン
    wrap.querySelector(".memo-row-pin").addEventListener("click", (e) => {
      e.stopPropagation();
      resetAllSwipes();
      togglePin(id);
    });
    wrap.querySelector(".memo-row-del").addEventListener("click", (e) => {
      e.stopPropagation();
      resetAllSwipes();
      confirmDelete(id);
    });

    // タッチ（スワイプ）
    let startX = 0;
    let startY = 0;
    let dx = 0;
    let active = false;
    const THRESHOLD = 60;
    row.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) return;
        // 他の行のスワイプ状態を解除
        resetAllSwipes(wrap);
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        dx = 0;
        active = true;
        wrap.classList.add("swiping");
        row.style.transition = "none";
      },
      { passive: true },
    );
    row.addEventListener(
      "touchmove",
      (e) => {
        if (!active) return;
        const x = e.touches[0].clientX;
        const y = e.touches[0].clientY;
        const diffX = x - startX;
        const diffY = y - startY;
        if (Math.abs(diffY) > Math.abs(diffX)) {
          // 縦スクロール優先
          active = false;
          wrap.classList.remove("swiping");
          row.style.transform = "";
          return;
        }
        dx = diffX;
        // 最大 ±120px 程度
        const clamped = Math.max(-140, Math.min(140, dx));
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
        row.style.transform = "translateX(-120px)";
        wrap.classList.add("swiped-left");
      } else if (dx >= THRESHOLD) {
        row.style.transform = "translateX(120px)";
        wrap.classList.add("swiped-right");
      } else {
        row.style.transform = "";
      }
    });
  });
}

function resetAllSwipes(exceptWrap) {
  if (!rootEl) return;
  rootEl.querySelectorAll(".memo-row-wrap").forEach((w) => {
    if (w === exceptWrap) return;
    const r = w.querySelector(".memo-row");
    if (r) r.style.transform = "";
    w.classList.remove("swiping", "swiped-left", "swiped-right");
  });
}

// ---------- Detail view ----------

function renderDetail() {
  const en = findEntry(state.detailId);
  if (!en) {
    return `<div class="memo-detail"><p class="empty-hint">見つかりませんでした。</p><button class="btn-ghost" id="d-back">← 戻る</button></div>`;
  }
  const def = MEMO_TYPE_DEFS[en.entry_type] || MEMO_TYPE_DEFS.note;
  const bodyHtml = linkifyBody(en.body || "");
  const hhmm = extractHhMmFromCreated(en.created_at);
  const claudeBadgeDetail = isClaudeTaken(en)
    ? `<span class="memo-detail-claude-badge" title="Claude取込み済み">✓Claude取込済</span>`
    : "";
  return `
    <div class="memo-detail">
      <div class="memo-detail-header">
        <button class="btn-back" id="d-back">← 戻る</button>
        <span class="memo-detail-label" style="background:${def.color}">${escapeHtml(def.label)}</span>
        <span class="memo-detail-time">${escapeHtml(en.date || "")} ${escapeHtml(hhmm)}</span>
        ${claudeBadgeDetail}
        <button class="btn-take-sm" id="d-take">取込む</button>
      </div>
      ${en.title ? `<h2 class="memo-detail-title">${escapeHtml(en.title)}</h2>` : ""}
      ${en.tags ? `<div class="memo-detail-tags">${escapeHtml(en.tags)}</div>` : ""}
      <div class="memo-detail-body">${bodyHtml}</div>
      <div class="memo-detail-footer">
        <button class="btn-ghost" id="d-edit">編集</button>
        <button class="btn-danger" id="d-delete">削除</button>
      </div>
    </div>
  `;
}

function bindDetail() {
  const back = rootEl.querySelector("#d-back");
  if (back) back.addEventListener("click", backToList);
  const edit = rootEl.querySelector("#d-edit");
  if (edit) {
    edit.addEventListener("click", () => {
      const en = findEntry(state.detailId);
      if (en) openEditor(en);
    });
  }
  const del = rootEl.querySelector("#d-delete");
  if (del) {
    del.addEventListener("click", () => confirmDelete(state.detailId));
  }
  const take = rootEl.querySelector("#d-take");
  if (take) {
    take.addEventListener("click", () => inboxEntry(state.detailId));
  }
}

function backToList() {
  state.view = "list";
  state.detailId = null;
  paintRoot();
}

// ---------- FAB / Type picker / Editor ----------

function openTypePicker() {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <header>種別を選択</header>
      <div class="modal-body">
        <button class="btn-type" data-type="journal" style="background:${MEMO_TYPE_DEFS.journal.color}">ジャーナル</button>
        <button class="btn-type" data-type="note" style="background:${MEMO_TYPE_DEFS.note.color}">ノート</button>
        <button class="btn-type" data-type="read_later" style="background:${MEMO_TYPE_DEFS.read_later.color}">あとで読む</button>
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
  const today = todayYmd();
  const now = nowJst();
  const hh = now.slice(11, 13);
  return {
    id: cryptoUuid(),
    entry_type: type,
    date: today,
    hour_slot: String(parseInt(hh, 10)),
    title: "",
    body: "",
    tags: "",
    created_at: now,
    updated_at: now,
    deleted: 0,
    claude_taken: 0,
    pinned: 0,
    _isNew: true,
  };
}

function openEditor(existing) {
  const en = { ...existing };
  const isNew = !!en._isNew;
  const type = en.entry_type;
  const def = MEMO_TYPE_DEFS[type] || MEMO_TYPE_DEFS.note;

  let bodyHtml = "";
  if (type === "journal") {
    bodyHtml = `
      <label>タイトル（任意）
        <input type="text" id="m-title" value="${escapeAttr(en.title || "")}" autocomplete="off" />
      </label>
      <label>本文（必須）
        <textarea id="m-body" rows="6">${escapeHtml(en.body || "")}</textarea>
      </label>
      <label>タグ（任意）
        <input type="text" id="m-tags" value="${escapeAttr(en.tags || "")}" autocomplete="off" />
      </label>
    `;
  } else if (type === "note") {
    bodyHtml = `
      <label>タイトル
        <input type="text" id="m-title" value="${escapeAttr(en.title || "")}" autocomplete="off" />
      </label>
      <label>本文
        <textarea id="m-body" rows="6">${escapeHtml(en.body || "")}</textarea>
      </label>
      <label>タグ
        <input type="text" id="m-tags" value="${escapeAttr(en.tags || "")}" autocomplete="off" />
      </label>
    `;
  } else {
    const existingUrl = extractUrlFromBody(en.body || "");
    bodyHtml = `
      <label>URL（必須）
        <input type="url" id="m-url" value="${escapeAttr(existingUrl)}" autocomplete="off" placeholder="https://…" />
      </label>
      <button class="btn-ghost" id="m-fetch" type="button">タイトル取得</button>
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
      <header>${isNew ? "新規" : "編集"}：${escapeHtml(def.label)}</header>
      <div class="modal-body">${bodyHtml}</div>
      <footer>
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
    delete updated._isNew;
    if (type === "journal") {
      const body = modal.querySelector("#m-body").value.trim();
      if (!body) {
        toast("本文を入力してください", "error");
        return;
      }
      updated.title = modal.querySelector("#m-title").value.trim();
      updated.body = body;
      updated.tags = modal.querySelector("#m-tags").value.trim();
    } else if (type === "note") {
      const title = modal.querySelector("#m-title").value.trim();
      const body = modal.querySelector("#m-body").value.trim();
      if (!title && !body) {
        toast("タイトルか本文を入力してください", "error");
        return;
      }
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
    }
    updated.updated_at = nowJst();
    updated.deleted = 0;
    close();
    await saveEntry(updated);
  });
}

// ---------- Save / Delete / Pin / Inbox ----------

async function saveEntry(entry) {
  store.upsertMemoAllLocal(entry);
  if (state.view === "list") paintBody();
  else paintRoot();
  try {
    showSpinner();
    const saved = await gas.pushMemoUpsert(entry);
    store.upsertMemoAllLocal(saved);
    if (state.view === "list") paintBody();
    else paintRoot();
    toast("保存しました", "success");
  } catch (e) {
    await outbox.enqueue({ type: "memo_upsert", payload: entry });
    toast("オフライン：送信キューに追加", "warn");
  } finally {
    hideSpinner();
  }
}

function confirmDelete(id) {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <header>削除の確認</header>
      <div class="modal-body">
        <p>本当に削除しますか？</p>
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
  store.deleteMemoAllLocal(id);
  if (state.view === "detail") backToList();
  else paintBody();
  try {
    showSpinner();
    await gas.pushMemoDelete(id);
    toast("削除しました", "success");
  } catch (e) {
    await outbox.enqueue({ type: "memo_delete", payload: { id } });
    toast("オフライン：削除キューに追加", "warn");
  } finally {
    hideSpinner();
  }
}

async function togglePin(id) {
  const en = findEntry(id);
  if (!en) return;
  const updated = { ...en, pinned: en.pinned ? 0 : 1, updated_at: nowJst() };
  store.upsertMemoAllLocal(updated);
  paintBody();
  try {
    showSpinner();
    const saved = await gas.pushMemoUpsert(updated);
    store.upsertMemoAllLocal(saved);
    paintBody();
    toast(updated.pinned ? "ピン留めしました" : "ピンを外しました", "success");
  } catch (e) {
    await outbox.enqueue({ type: "memo_upsert", payload: updated });
    toast("オフライン：送信キューに追加", "warn");
  } finally {
    hideSpinner();
  }
}

async function inboxEntry(id) {
  try {
    showSpinner();
    const res = await gas.pushMemoInboxWrite(id, "");
    const en = findEntry(id);
    if (en) {
      en.claude_taken = 1;
      store.upsertMemoAllLocal(en);
    }
    if (state.view === "list") paintBody();
    else paintRoot();
    toast(`取込みました（${res.taken || 0}件）`, "success");
  } catch (e) {
    toast("取込失敗：" + e.message, "error");
  } finally {
    hideSpinner();
  }
}

// ---------- Pull ----------

export async function pullAndRender() {
  showSpinner();
  try {
    await flushOutbox();
    const sinceYmd = addDaysYmd(todayYmd(), -365);
    const res = await gas.pullMemoAll(sinceYmd, 1000);
    store.saveMemoAll(res.entries || []);
    if (state.view === "list") paintBody();
    else paintRoot();
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
        continue;
      }
      await outbox.remove(item.id);
    } catch (e) {
      throw e;
    }
  }
}

// ---------- helpers ----------

function findEntry(id) {
  const list = store.loadMemoAll();
  return list.find((e) => e.id === id) || null;
}

function dateGroupLabel(ymd) {
  if (!ymd) return "(日付なし)";
  const today = todayYmd();
  const yesterday = addDaysYmd(today, -1);
  if (ymd === today) return "今日";
  if (ymd === yesterday) return "昨日";
  return ymd;
}

function extractHhMmFromCreated(created) {
  const m = String(created || "").match(/(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : "";
}

function extractDateFromCreated(created) {
  const m = String(created || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

function firstLine(s, max) {
  const t = String(s || "")
    .split(/\r?\n/)[0]
    .trim();
  if (max && t.length > max) return t.slice(0, max) + "…";
  return t;
}

function extractUrlFromBody(body) {
  const m = String(body || "").match(/^https?:\/\/\S+/);
  return m ? m[0] : "";
}

function linkifyBody(body) {
  const esc = escapeHtml(body);
  return esc.replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>',
  );
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
