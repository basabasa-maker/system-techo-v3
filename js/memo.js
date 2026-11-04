// memo.js - Memo タブ（iPhoneメモアプリ風リスト形式）
// 仕様書 Sprint 3 再実装版：
// - 縦スクロールのリスト、日付でグループ化（今日／昨日／YYYY-MM-DD）
// - ソート切替（新しい順/古い順）、全文検索
// - 右スワイプ → ピン留め / 左スワイプ → 削除
// - ピン留めは全日付をまとめて先頭の枠に出す
// - 行の長押しで上下に移動（ピン枠・各日付の枠の中で入れ替え）。既定の並びは入力日時順
// - 日記（journal）はDailyタブの内容なので、Memoタブには出さない
// - 行タップで詳細画面（全画面遷移）
// - 種別の選択は廃止。メモは1種類（ロディアのブロックメモ風の罫線入り）
//   新規は保存時に種別 "note" として記録する

import * as store from "./store.js";
import * as gas from "./gas-client.js";
import * as outbox from "./outbox.js";
import { toast, showSpinner, hideSpinner } from "./toast.js";
import { todayYmd, nowJst, addDaysYmd } from "./date-util.js";
import { enableLongPressReorder, justDragged } from "./reorder.js";

const state = {
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
  syncQuietly();
}

// タブを開いたとき、画面を止めずに最新の一覧へ入れ替える（失敗しても手元の表示のまま）
async function syncQuietly() {
  try {
    // 送信待ちが送れなくても、取得は続ける
    await flushOutbox().catch(() => {});
    const res = await gas.pullMemoAll(addDaysYmd(todayYmd(), -365), 1000);
    store.saveMemoAll(res.entries || []);
    if (rootEl && state.view === "list" && rootEl.querySelector("#memo-body")) {
      paintBody();
    }
  } catch (e) {
    console.warn("memo sync skipped:", e.message);
  }
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
          <input type="search" id="memo-q" placeholder="検索（本文）" value="${escapeAttr(state.searchQuery)}" />
        </div>
        <div class="memo-action-row">
          <button class="btn-sort" id="memo-sort">${state.sortDesc ? "新しい順" : "古い順"}</button>
        </div>
      </div>
      <div id="memo-body"></div>
      <button id="btn-new-memo" class="fab" aria-label="新規メモ">＋</button>
    </div>
  `;
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
  rootEl.querySelector("#memo-sort").addEventListener("click", () => {
    state.sortDesc = !state.sortDesc;
    rootEl.querySelector("#memo-sort").textContent = state.sortDesc
      ? "新しい順"
      : "古い順";
    paintBody();
  });
  rootEl
    .querySelector("#btn-new-memo")
    .addEventListener("click", () => openEditor(newEntry()));
}

// ---------- List body ----------

function paintBody() {
  const bodyEl = rootEl.querySelector("#memo-body");
  if (!bodyEl) return;
  const all = store.loadMemoAll();
  const needle = state.searchQuery.trim().toLowerCase();
  const filtered = all.filter((e) => {
    if (e.deleted) return false;
    // 日記（journal）はDailyタブの内容。Memoタブには出さない
    if (e.entry_type === "journal") return false;
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
  // ピン留めは全日付をまとめて先頭の枠に。それ以外は日付ごとのグループ
  const pinned = filtered.filter((e) => e.pinned);
  const groups = {};
  const order = [];
  for (const en of filtered) {
    if (en.pinned) continue;
    const d = en.date || extractDateFromCreated(en.created_at) || "";
    if (!groups[d]) {
      groups[d] = [];
      order.push(d);
    }
    groups[d].push(en);
  }
  order.sort((a, b) => (state.sortDesc ? (a < b ? 1 : -1) : a < b ? -1 : 1));
  let html = `<div class="memo-list">`;
  if (pinned.length > 0) {
    pinned.sort(compareMemo);
    html += `<div class="memo-date-header">📌 ピン留め</div>`;
    html += `<div class="memo-group" data-group="pinned">`;
    for (const en of pinned) html += memoRowHtml(en);
    html += `</div>`;
  }
  for (const d of order) {
    const list = groups[d];
    list.sort(compareMemo);
    html += `<div class="memo-date-header">${escapeHtml(dateGroupLabel(d))}</div>`;
    html += `<div class="memo-group" data-group="${escapeAttr(d)}">`;
    for (const en of list) html += memoRowHtml(en);
    html += `</div>`;
  }
  html += `</div>`;
  bodyEl.innerHTML = html;
  bindRowEvents(bodyEl);

  // 長押しで上下に移動。ピン留めの枠・各日付の枠の中だけで入れ替える
  bodyEl.querySelectorAll(".memo-group").forEach((g) => {
    enableLongPressReorder(g, {
      itemSelector: ".memo-row-wrap",
      onReorder: onReorderMemos,
    });
  });
}

// 並び: 長押しで決めた順（sort_order）を優先。決めていないものは入力日時順。
// 並べ替えた後に新しく書いたメモは、新しい順なら先頭、古い順なら末尾に入る
function compareMemo(a, b) {
  const ao = Number(a.sort_order) || 0;
  const bo = Number(b.sort_order) || 0;
  if (ao && bo) return ao - bo;
  if (ao || bo) {
    const newFirst = state.sortDesc ? -1 : 1;
    return ao ? -newFirst : newFirst;
  }
  const ka = a.created_at || "";
  const kb = b.created_at || "";
  if (ka === kb) return 0;
  return state.sortDesc ? (ka < kb ? 1 : -1) : ka < kb ? -1 : 1;
}

// 並べ替え結果を sort_order に保存する（変わった行だけ1件ずつ送信）
async function onReorderMemos(ids) {
  const changed = [];
  ids.forEach((id, i) => {
    const en = findEntry(id);
    if (!en) return;
    const order = (i + 1) * 10;
    if (Number(en.sort_order) !== order) {
      const next = { ...en, sort_order: order, updated_at: nowJst() };
      store.upsertMemoAllLocal(next);
      changed.push(next);
    }
  });
  paintBody();
  for (const en of changed) {
    try {
      await gas.pushMemoUpsert(en);
    } catch (e) {
      await outbox.enqueue({ type: "memo_upsert", payload: en });
      toast("オフライン：送信キューに追加", "warn");
      break;
    }
  }
}

function memoRowHtml(en) {
  const hhmm = extractHhMmFromCreated(en.created_at);
  const title = en.title || firstLine(en.body) || "(無題)";
  // タイトルが無いときは本文の1行目が見出しになる。その場合の下段は2行目以降を出す
  const preview = en.title
    ? firstLine(en.body || "", 80)
    : firstLine(
        String(en.body || "")
          .split(/\r?\n/)
          .slice(1)
          .join(" "),
        80,
      );
  const pinIcon = en.pinned ? `<span class="memo-pin-icon">📌</span>` : "";
  const claudeBadge = isClaudeTaken(en)
    ? `<span class="memo-claude-badge" title="Claude取込み済み">✓Claude</span>`
    : "";
  return `
    <div class="memo-row-wrap" data-id="${escapeAttr(en.id)}">
      <div class="memo-row-action memo-row-pin" data-action="pin">${en.pinned ? "ピン解除" : "ピン留め"}</div>
      <div class="memo-row-action memo-row-del" data-action="del">削除</div>
      <div class="memo-row" data-id="${escapeAttr(en.id)}">
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
      // 並べ替えの直後・スワイプ中なら無視
      if (justDragged()) return;
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
    let locked = null; // null=未決定 / "h"=横スワイプ / "v"=縦スクロール
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
        const x = e.touches[0].clientX;
        const y = e.touches[0].clientY;
        const diffX = x - startX;
        const diffY = y - startY;
        // 動き始めの10pxは縦か横か決めない（縦スクロール中に行が横へ揺れるのを防ぐ）
        if (locked === null) {
          if (Math.max(Math.abs(diffX), Math.abs(diffY)) < 10) return;
          locked = Math.abs(diffX) > Math.abs(diffY) * 1.5 ? "h" : "v";
        }
        if (locked === "v") {
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
  const bodyHtml = linkifyBody(en.body || "");
  const hhmm = extractHhMmFromCreated(en.created_at);
  const claudeBadgeDetail = isClaudeTaken(en)
    ? `<span class="memo-detail-claude-badge" title="Claude取込み済み">✓Claude取込済</span>`
    : "";
  return `
    <div class="memo-detail">
      <div class="memo-detail-header">
        <button class="btn-back" id="d-back">← 戻る</button>
        <span class="memo-detail-time">${escapeHtml(en.date || "")} ${escapeHtml(hhmm)}</span>
        ${claudeBadgeDetail}
        <button class="btn-take-sm" id="d-take">取込む</button>
      </div>
      ${en.title ? `<h2 class="memo-detail-title">${escapeHtml(en.title)}</h2>` : ""}
      ${en.tags ? `<div class="memo-detail-tags">${escapeHtml(en.tags)}</div>` : ""}
      <div class="memo-detail-body memo-paper">${bodyHtml}</div>
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

function newEntry() {
  const today = todayYmd();
  const now = nowJst();
  const hh = now.slice(11, 13);
  return {
    id: cryptoUuid(),
    entry_type: "note",
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

// 罫線の空き行をタップしたら、その行まで改行を足してカーソルを置く
function bindPaperTap(ta) {
  const LINE = 32;
  const mirror = document.createElement("div");
  const renderedHeight = () => {
    const cs = getComputedStyle(ta);
    mirror.style.cssText =
      "position:absolute;visibility:hidden;left:-9999px;top:0;white-space:pre-wrap;word-wrap:break-word;" +
      `width:${ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)}px;` +
      `font:${cs.font};line-height:${LINE}px;`;
    mirror.textContent = ta.value + "\n";
    document.body.appendChild(mirror);
    const h = mirror.offsetHeight - LINE; // 末尾の改行ぶんを除く
    mirror.remove();
    return h;
  };
  ta.addEventListener("click", (e) => {
    const rect = ta.getBoundingClientRect();
    const y = e.clientY - rect.top + ta.scrollTop;
    const usedLines = Math.max(1, Math.round(renderedHeight() / LINE));
    const tapLine = Math.floor(y / LINE);
    if (tapLine < usedLines) return; // 文字がある行は、ふつうに位置が決まる
    const add = tapLine - usedLines + 1;
    // 最終行が空でなければ、そこから改行して目的の行へ
    ta.value = ta.value + "\n".repeat(add);
    const end = ta.value.length;
    ta.setSelectionRange(end, end);
    ta.focus();
  });
  setTimeout(() => ta.focus(), 50);
}

function openEditor(existing) {
  const en = { ...existing };
  const isNew = !!en._isNew;

  // メモは本文1つだけ。ロディア風の罫線入り用紙に書く。
  // 過去メモにタイトルが付いている場合だけ、消えないようにタイトル欄も出す
  const titleHtml = en.title
    ? `<input type="text" id="m-title" class="memo-title-input" value="${escapeAttr(en.title)}" autocomplete="off" placeholder="タイトル" />`
    : "";

  const modal = document.createElement("div");
  modal.className = "modal-backdrop memo-backdrop";
  modal.innerHTML = `
    <div class="modal memo-modal">
      <header>${isNew ? "新しいメモ" : "メモを編集"}</header>
      <div class="modal-body memo-modal-body">
        ${titleHtml}
        <textarea id="m-body" class="memo-paper memo-paper-input" rows="9" placeholder="ここにメモ">${escapeHtml(en.body || "")}</textarea>
      </div>
      <footer>
        <div style="flex:1"></div>
        <button class="btn-ghost" id="m-cancel">キャンセル</button>
        <button class="btn-primary" id="m-save">保存</button>
      </footer>
    </div>`;
  document.body.appendChild(modal);
  bindPaperTap(modal.querySelector("#m-body"));
  // キーボードで隠れないよう、見えている高さに合わせる
  const vv = window.visualViewport;
  const fit = () => {
    if (vv) modal.style.setProperty("--memo-h", vv.height + "px");
  };
  if (vv) {
    vv.addEventListener("resize", fit);
    fit();
  }
  const close = () => {
    if (vv) vv.removeEventListener("resize", fit);
    modal.remove();
  };
  modal.querySelector("#m-cancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });

  modal.querySelector("#m-save").addEventListener("click", async () => {
    const updated = { ...en };
    delete updated._isNew;
    const body = modal.querySelector("#m-body").value.trim();
    const titleEl = modal.querySelector("#m-title");
    const title = titleEl ? titleEl.value.trim() : en.title || "";
    if (!title && !body) {
      toast("メモを入力してください", "error");
      return;
    }
    updated.title = title;
    updated.body = body;
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
