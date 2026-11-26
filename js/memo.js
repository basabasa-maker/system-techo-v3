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

import { splitBody } from "./memo/body.js";
import { createMemoDocument } from "./memo/document.js";
import { createMemoEditor } from "./memo/editor.js";
import { createMemoRepository } from "./memo/repository.js";
import { uploadFile, loadAttachment } from "./memo/attachments.js";
import * as store from "./store.js";
import * as gas from "./gas-client.js";
import * as outbox from "./outbox.js";
import * as sync from "./sync.js";
import { toast, showSpinner, hideSpinner } from "./toast.js";
import { todayYmd, nowJst, addDaysYmd } from "./date-util.js";
import { enableLongPressReorder, justDragged } from "./reorder.js";

const state = {
  searchQuery: "",
  sortDesc: true,
  showArchived: false, // true のとき、アーカイブしたメモの一覧
  view: "list", // list | detail
  detailId: null,
  draft: null, // まだ保存していない新規メモ
};

let rootEl = null;
let swipeCtx = null; // 現在スワイプ中の行情報
let detailSession = null;
const RULED_KEY = "sth_v3_memo_ruled";
const memoRepository = createMemoRepository({
  storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) },
  queue: (op, delay) => sync.queue(op, delay, { durableRecovery: true }),
  loadMemo: findEntry,
});

export function renderMemoTab(container) {
  if (disposeDetail() === false) return;
  rootEl = container;
  paintRoot();
  syncQuietly();
}

// タブを開いたとき、画面を止めずに最新の一覧へ入れ替える（失敗しても手元の表示のまま）
async function syncQuietly() {
  const revisions = memoRevisions();
  try {
    // 送信待ちが送れなくても、取得は続ける
    await flushOutbox().catch(() => {});
    const res = await gas.pullMemoAll("2000-01-01", 2000);
    await applyPulledMemos(res.entries || [], revisions);
    if (rootEl && state.view === "list" && rootEl.querySelector("#memo-body")) {
      paintBody();
    }
  } catch (e) {
    console.warn("memo sync skipped:", e.message);
  }
}

function paintRoot() {
  if (!rootEl?.isConnected) return;
  if (disposeDetail() === false) return;
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
          <button class="btn-sort" id="memo-arch-toggle">${state.showArchived ? "← メモに戻る" : "アーカイブ"}</button>
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
  rootEl.querySelector("#memo-arch-toggle").addEventListener("click", () => {
    state.showArchived = !state.showArchived;
    paintRoot();
  });
  rootEl
    .querySelector("#btn-new-memo")
    .addEventListener("click", () => {
      state.showArchived = false; // 新しいメモは、ふつうの一覧に出る
      const en = newEntry();
      state.draft = en;
      state.view = "detail";
      state.detailId = en.id;
      paintRoot();
    });
}

// ---------- List body ----------

function paintBody() {
  const bodyEl = rootEl.querySelector("#memo-body");
  if (!bodyEl) return;
  const all = store.loadMemoAll();
  const needle = state.searchQuery.trim().toLowerCase();
  const filtered = all.filter((e) => {
    if (e.deleted) return false;
    // アーカイブしたメモは、アーカイブの一覧にだけ出す
    if (!!e.archived !== state.showArchived) return false;
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
    bodyEl.innerHTML = `<p class="empty-hint">${state.showArchived ? "アーカイブしたメモはありません。" : "メモはまだありません。"}</p>`;
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
  const results = await Promise.allSettled(changed.map(en => memoRepository.queue({ type: "memo_upsert", payload: en }, 300)));
  if (results.some(result => result.status === "rejected")) toast("並び順を端末に保存しました。送信は待機中です。", "warn");
}

function memoRowHtml(en) {
  // 1行目＝タイトル（無ければ本文の1行目）。2行目＝日時（＋取込済）。本文は出さない
  const text = splitBody(en.body).text;
  const title = en.title || firstLine(text) || "(無題)";
  const when = `${en.date || extractDateFromCreated(en.created_at)} ${extractHhMmFromCreated(en.created_at)}`.trim();
  const taken = takenLabel(en);
  const pin = en.pinned ? `<span class="memo-pin-icon">📌</span>` : "";
  return `
    <div class="memo-row-wrap" data-id="${escapeAttr(en.id)}">
      <div class="memo-row-action memo-row-pin" data-action="pin">${en.pinned ? "ピン解除" : "ピン留め"}</div>
      <div class="memo-row-action memo-row-arch" data-action="arch">${en.archived ? "戻す" : "アーカイブ"}</div>
      <div class="memo-row-action memo-row-del" data-action="del">削除</div>
      <div class="memo-row" data-id="${escapeAttr(en.id)}">
        <div class="memo-row-inner">
          <div class="memo-row-head">
            <span class="memo-row-title">${escapeHtml(title)}</span>
            ${pin}
          </div>
          <div class="memo-row-sub">
            <span class="memo-row-time">${escapeHtml(when)}</span>
            ${taken ? `<span class="memo-claude-badge">${escapeHtml(taken)}</span>` : ""}
          </div>
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
    return s === "1" || s === "true" || /^\d{4}-\d{2}-\d{2}/.test(s);
  }
  return false;
}

// 「取込済」＋取り込んだ日時（日時が分かるときだけ）
function takenLabel(en) {
  if (!isClaudeTaken(en)) return "";
  const m = String(en.claude_taken).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `取込済 ${m[2]}/${m[3]} ${m[4]}:${m[5]}` : "取込済";
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
    wrap.querySelector(".memo-row-arch").addEventListener("click", (e) => {
      e.stopPropagation();
      resetAllSwipes();
      setArchived(id, !(findEntry(id) || {}).archived);
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
        const clamped = Math.max(-210, Math.min(140, dx));
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
        row.style.transform = "translateX(-188px)";
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
  if (!rootEl?.isConnected) return;
  rootEl.querySelectorAll(".memo-row-wrap").forEach((w) => {
    if (w === exceptWrap) return;
    const r = w.querySelector(".memo-row");
    if (r) r.style.transform = "";
    w.classList.remove("swiping", "swiped-left", "swiped-right");
  });
}

// ---------- Detail view（開いたらすぐ書ける） ----------

function currentEntry() {
  return findEntry(state.detailId) || (state.draft && state.draft.id === state.detailId ? state.draft : null);
}

function renderDetail() {
  const en = currentEntry();
  if (!en) {
    return `<div class="memo-detail"><p class="empty-hint">見つかりませんでした。</p><button class="btn-ghost" id="d-back">← 戻る</button></div>`;
  }
  const hhmm = extractHhMmFromCreated(en.created_at);
  const taken = takenLabel(en);
  return `
    <div class="memo-detail">
      <div class="memo-detail-header">
        <button class="btn-back" id="d-back">← 戻る</button>
        <span class="memo-detail-time">${escapeHtml(en.date || "")} ${escapeHtml(hhmm)}${taken ? ` ・ ${escapeHtml(taken)}` : ""}</span>
      </div>
      <div class="memo-tools">
        <button class="memo-tool" id="d-check">チェック</button>
        <button class="memo-tool" id="d-lines" aria-pressed="${memoRuled()}">${memoRuled() ? "罫線あり" : "罫線なし"}</button>
        <button class="memo-tool" id="d-attach">📎 添付</button>
        <button class="memo-tool" id="d-copy">コピー</button>
        <button class="memo-tool" id="d-take">取込む</button>
        <input type="file" id="d-file" multiple hidden />
      </div>
      ${en.title ? `<input type="text" id="d-title" class="memo-detail-title-input" value="${escapeAttr(en.title)}" autocomplete="off" placeholder="タイトル" />` : ""}
      <div class="memo-wrap"><div id="d-text" class="memo-editor-host"></div></div>
      <div id="d-atts" class="memo-atts"></div>
      <div class="memo-detail-footer">
        ${findEntry(en.id) ? `<button class="btn-ghost" id="d-archive">${en.archived ? "メモに戻す" : "アーカイブ"}</button>` : ""}
        <button class="btn-danger" id="d-delete">削除</button>
      </div>
    </div>
  `;
}

function memoRuled() {
  try { return localStorage.getItem(RULED_KEY) !== "0"; } catch (_) { return true; }
}

function disposeDetail() {
  const session = detailSession;
  if (!session) return true;
  try {
    // Serialization and the local write run synchronously, so failure keeps
    // the current editor in place instead of discarding unsaved text.
    const saving = session.persist(true);
    detailSession = null;
    session.destroy();
    saving.catch(error => toast("保存待ち：" + error.message, "warn"));
    return true;
  } catch (error) {
    toast("保存待ち：" + error.message, "warn");
    return false;
  }
}

export function disposeMemoTab() {
  if (disposeDetail() === false) return false;
  rootEl = null;
  return true;
}

function bindDetail() {
  const en0 = currentEntry();
  if (!en0) {
    rootEl.querySelector("#d-back")?.addEventListener("click", backToList);
    return;
  }
  const entryId = en0.id;
  const host = rootEl.querySelector("#d-text");
  const detail = rootEl.querySelector(".memo-detail");
  const titleEl = rootEl.querySelector("#d-title");
  const document = createMemoDocument(en0.body);
  let atts = document.atts;
  let text = document.text;
  let title = en0.title || "";
  let lastBody = en0.body || "";
  let lastTitle = title;
  let entry = en0;
  let wasSaved = !!findEntry(entryId);
  let discarded = false;
  let active = true;
  let composing = false;
  let saveTimer = null;
  let saveRevision = 0;
  let retry = false;
  let editor;
  const session = {
    id: entryId,
    persist,
    async addAttachment(attachment) {
      if (discarded) return;
      atts = [...atts, attachment];
      if (isVisible()) paintAtts();
      await persist(true);
    },
    destroy() {
      active = false;
      clearTimeout(saveTimer);
      viewportCleanup();
      window.removeEventListener("pagehide", onLeave);
      globalThis.document.removeEventListener("visibilitychange", onVisibility);
      editor.destroy();
    },
    discard() { discarded = true; },
    isComposing: () => composing || editor.isComposing(),
  };
  const isVisible = () => active && detailSession === session && host.isConnected;
  function persist(force = false) {
    clearTimeout(saveTimer);
    if (discarded || (!force && (composing || editor?.isComposing()))) return Promise.resolve();
    const current = findEntry(entryId);
    if (wasSaved && !current) return Promise.resolve();
    const cur = current || entry;
    if (cur.deleted) return Promise.resolve();
    const body = document.serialize(text, atts);
    if (!retry && body === lastBody && title === lastTitle) return Promise.resolve();
    if (!title && !text && atts.length === 0 && !wasSaved) return Promise.resolve();
    const next = { ...cur, title, body, updated_at: nowJst(), deleted: 0 };
    delete next._isNew;
    // saveQuiet writes the local record before returning its queue promise.
    // A failed local write cannot mark a new record as already saved/deleted.
    const saving = saveQuiet(next);
    const revision = ++saveRevision;
    entry = next;
    wasSaved = true;
    lastBody = body;
    lastTitle = title;
    retry = false;
    if (isVisible()) state.draft = next;
    return saving.catch(error => {
      if (revision === saveRevision) retry = true;
      throw error;
    });
  }
  function safePersist(force = false) {
    try { return persist(force).catch(error => toast("保存待ち：" + error.message, "warn")); }
    catch (error) { toast("保存待ち：" + error.message, "warn"); return Promise.resolve(); }
  }
  function schedule() {
    clearTimeout(saveTimer);
    if (composing || editor?.isComposing()) return;
    saveTimer = setTimeout(() => safePersist(), 700);
  }
  editor = createMemoEditor(host, {
    text,
    ruled: memoRuled(),
    onChange(value) { text = value; schedule(); },
    onCompositionChange(value) {
      composing = value;
      if (value) clearTimeout(saveTimer);
      else queueMicrotask(schedule);
    },
    onFiles: addFiles,
  });
  detailSession = session;
  const viewportCleanup = bindMemoViewport(detail);
  const onLeave = () => safePersist(true);
  const onVisibility = () => { if (globalThis.document.visibilityState === "hidden") onLeave(); };
  window.addEventListener("pagehide", onLeave);
  globalThis.document.addEventListener("visibilitychange", onVisibility);
  if (titleEl) titleEl.addEventListener("input", () => { title = titleEl.value.trim(); schedule(); });

  rootEl.querySelector("#d-back").addEventListener("click", async () => {
    try { await persist(true); } catch (error) { toast("保存待ち：" + error.message, "warn"); return; }
    if (isVisible()) backToList();
  });
  rootEl.querySelector("#d-delete").addEventListener("click", () => confirmDelete(entryId));
  const archBtn = rootEl.querySelector("#d-archive");
  if (archBtn) archBtn.addEventListener("click", async () => {
    try {
      await persist(true);
      const cur = findEntry(entryId);
      if (isVisible()) backToList();
      if (cur) setArchived(entryId, !cur.archived);
    } catch (error) { toast("保存待ち：" + error.message, "warn"); }
  });
  rootEl.querySelector("#d-take").addEventListener("click", async () => {
    try { await persist(true); await inboxEntry(entryId); }
    catch (error) { toast("保存待ち：" + error.message, "warn"); }
  });
  rootEl.querySelector("#d-copy").addEventListener("click", () => copyText(text));
  rootEl.querySelector("#d-check").addEventListener("click", () => editor.toggleChecklist());
  rootEl.querySelector("#d-lines").addEventListener("click", event => {
    const ruled = event.currentTarget.getAttribute("aria-pressed") !== "true";
    editor.setRuled(ruled);
    event.currentTarget.setAttribute("aria-pressed", String(ruled));
    event.currentTarget.textContent = ruled ? "罫線あり" : "罫線なし";
    try { localStorage.setItem(RULED_KEY, ruled ? "1" : "0"); } catch (_) {}
  });

  const fileEl = rootEl.querySelector("#d-file");
  rootEl.querySelector("#d-attach").addEventListener("click", () => fileEl.click());
  fileEl.addEventListener("change", () => {
    const files = Array.from(fileEl.files || []);
    fileEl.value = "";
    addFiles(files);
  });
  async function addFiles(files) {
    for (const file of files) {
      try {
        showSpinner();
        const up = await uploadFile(file);
        if (discarded || (wasSaved && !findEntry(entryId))) continue;
        const attachment = { ...up, name: up.name.replace(/[|\]\r\n]/g, "_") };
        if (detailSession?.id === entryId && detailSession !== session) {
          await detailSession.addAttachment(attachment);
        } else if (!isVisible() && findEntry(entryId)) {
          const current = findEntry(entryId);
          const latest = createMemoDocument(current.body);
          await saveQuiet({ ...current, body: latest.serialize(latest.text, [...latest.atts, attachment]), updated_at: nowJst() });
        } else {
          await session.addAttachment(attachment);
        }
      } catch (error) { toast("添付に失敗：" + error.message, "error"); }
      finally { hideSpinner(); }
    }
  }
  function paintAtts() {
    if (!isVisible()) return;
    const box = detail.querySelector("#d-atts");
    box.replaceChildren();
    atts.forEach((a, i) => {
      const item = globalThis.document.createElement("div");
      item.className = "memo-att";
      const rm = globalThis.document.createElement("button");
      rm.className = "memo-att-rm";
      rm.textContent = "×";
      rm.setAttribute("aria-label", "添付を外す");
      rm.addEventListener("click", () => {
        if (!confirm(`「${a.name}」を外しますか？`)) return;
        atts = atts.filter((_, j) => j !== i);
        paintAtts();
        safePersist(true);
      });
      if (/^image\//.test(a.mime)) {
        const img = globalThis.document.createElement("img");
        img.alt = a.name; img.className = "memo-att-img"; item.appendChild(img);
        loadAttachment(a).then(url => {
          if (!img.isConnected) return;
          img.src = url; img.addEventListener("click", () => openViewer(url));
        }).catch(() => {
          if (!img.isConnected) return;
          item.insertBefore(Object.assign(globalThis.document.createElement("span"), { textContent: "画像を読めません：" + a.name }), rm);
          img.remove();
        });
      } else {
        const button = globalThis.document.createElement("button");
        button.className = "memo-att-file"; button.textContent = "📎 " + a.name;
        button.addEventListener("click", async () => {
          try {
            const url = await loadAttachment(a);
            const link = globalThis.document.createElement("a");
            link.href = url; link.download = a.name; link.click();
          } catch (error) { toast("開けません：" + error.message, "error"); }
        });
        item.appendChild(button);
      }
      item.appendChild(rm); box.appendChild(item);
    });
  }
  paintAtts();
}

// Only the document scroller moves. Keep the editor inside the visible viewport
// without mirrored text, a fake caret or scroll-position correction loops.
function bindMemoViewport(detail) {
  const viewport = window.visualViewport;
  let frame = 0;
  const measure = () => {
    frame = 0;
    if (!detail.isConnected) return;
    // The main scroller is a direct child of the fixed, top:0 app shell.
    // offsetTop stays in that layout coordinate system. Its client rect moves
    // during iOS keyboard panning and would apply the same shift a second time.
    const top = Math.max(0, globalThis.document.getElementById("scroll-container")?.offsetTop || 0);
    const bottom = viewport ? viewport.height + viewport.offsetTop : window.innerHeight;
    detail.style.top = top + "px";
    detail.style.height = Math.max(120, bottom - top) + "px";
    detail.classList.toggle("memo-keyboard-open", !!viewport && window.innerHeight - viewport.height > 120);
  };
  const request = () => { if (!frame) frame = requestAnimationFrame(measure); };
  measure();
  viewport?.addEventListener("resize", request);
  window.addEventListener("resize", request);
  window.addEventListener("orientationchange", request);
  return () => {
    cancelAnimationFrame(frame);
    viewport?.removeEventListener("resize", request);
    window.removeEventListener("resize", request);
    window.removeEventListener("orientationchange", request);
  };
}

function backToList() {
  if (disposeDetail() === false) return;
  state.view = "list";
  state.detailId = null;
  state.draft = null;
  paintRoot();
}

// ---------- 添付ファイル ----------

function openViewer(url) {
  const v = document.createElement("div");
  v.className = "memo-viewer";
  v.innerHTML = `<img src="${url}" alt="" />`;
  v.addEventListener("click", () => v.remove());
  document.body.appendChild(v);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("コピーしました", "success");
  } catch (e) {
    const t = document.createElement("textarea");
    t.value = text;
    t.style.cssText = "position:fixed;left:-9999px;top:0;font-size:16px";
    document.body.appendChild(t);
    t.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e2) {
      /* ignore */
    }
    t.remove();
    toast(ok ? "コピーしました" : "コピーできませんでした", ok ? "success" : "error");
  }
}

// ---------- FAB / 新規 ----------

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

// ---------- Save / Delete / Pin / Inbox ----------

// 書いている最中の自動保存（画面は作り直さない・音も出さない）
function saveQuiet(entry) {
  store.upsertMemoAllLocal(entry);
  // Persist the operation before sending; older server replies never repaint
  // the editor or overwrite a newer local memo.
  return memoRepository.queue({ type: "memo_upsert", payload: entry }, 1);
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
  try {
    // A failed local delete must leave the live editor writable and saveable.
    store.deleteMemoAllLocal(id);
    if (detailSession?.id === id) detailSession.discard();
    if (state.view === "detail") backToList();
    else paintBody();
    await memoRepository.queue({ type: "memo_delete", payload: { id } }, 1);
    await sync.flushAll();
    toast((await sync.pendingKeys()).has("memo:" + id) ? "オフライン：削除キューに追加" : "削除しました", "success");
  } catch (error) { toast("削除待ち：" + error.message, "warn"); }
}

async function updateMemoFlag(id, field, value, message) {
  const current = findEntry(id);
  if (!current) return;
  const updated = { ...current, [field]: value, updated_at: nowJst() };
  store.upsertMemoAllLocal(updated);
  if (state.view === "list") paintBody();
  try {
    await memoRepository.queue({ type: "memo_upsert", payload: updated }, 1);
    await sync.flushAll();
    toast((await sync.pendingKeys()).has("memo:" + id) ? "オフライン：送信キューに追加" : message, "success");
  } catch (error) { toast("保存待ち：" + error.message, "warn"); }
}

function setArchived(id, flag) {
  return updateMemoFlag(id, "archived", flag ? 1 : 0, flag ? "アーカイブしました" : "メモに戻しました");
}

function togglePin(id) {
  const current = findEntry(id);
  if (!current) return;
  return updateMemoFlag(id, "pinned", current.pinned ? 0 : 1, current.pinned ? "ピンを外しました" : "ピン留めしました");
}

async function inboxEntry(id) {
  try {
    showSpinner();
    await flushOutbox();
    if (memoRepository.getProtectedIds().has(id) || (await sync.pendingKeys()).has("memo:" + id)) throw new Error("本文の保存が待機中です。通信が戻ってから取り込んでください。");
    if (!findEntry(id)) throw new Error("メモが見つかりません。");
    const res = await gas.pushMemoInboxWrite(id, "");
    const en = findEntry(id);
    if (en) {
      en.claude_taken = nowJst();
      store.upsertMemoAllLocal(en);
    }
    if (state.view === "list") paintBody();
    else if (detailSession?.id === id && en) {
      const label = rootEl?.querySelector(".memo-detail-time");
      if (label) label.textContent = `${en.date || ""} ${extractHhMmFromCreated(en.created_at)} ・ ${takenLabel(en)}`;
    }
    toast(`取込みました（${res.taken || 0}件）`, "success");
  } catch (e) {
    toast("取込失敗：" + e.message, "error");
  } finally {
    hideSpinner();
  }
}

// ---------- Pull ----------

export async function pullAndRender() {
  const view = rootEl;
  showSpinner();
  try {
    if (detailSession) await detailSession.persist();
    const revisions = memoRevisions();
    await flushOutbox().catch(() => {});
    const res = await gas.pullMemoAll("2000-01-01", 2000);
    await applyPulledMemos(res.entries || [], revisions);
    const typing = view?.contains(document.activeElement) && (document.activeElement.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName));
    if (view === rootEl && view?.isConnected && !typing && !document.querySelector(".modal-backdrop")) {
      if (state.view === "list") paintBody();
      // A live editor owns its document until closed, including while blurred.
    }
    toast("最新化しました" + (await sync.pendingNote()), "success");
  } catch (e) {
    console.error(e);
    toast("取得に失敗しました: " + e.message, "error");
  } finally {
    hideSpinner();
  }
}

async function flushOutbox() {
  // Enqueue failures retain a small durable marker across reloads. Recover from
  // the latest local record before fetching any server snapshot.
  await memoRepository.replay();
  return sync.flushAll();
}

// 取得した一覧で手元の一覧を置き換える。ただし、まだ送っていないメモは手元の版を残す
function memoRevisions() {
  return new Map(store.loadMemoAll().map(entry => [entry.id, sync.revision("memo:" + entry.id)]));
}

async function applyPulledMemos(entries, revisions = memoRevisions()) {
  const keys = await sync.pendingKeys();
  for (const id of memoRepository.getProtectedIds()) keys.add("memo:" + id);
  const local = store.loadMemoAll();
  const keep = local.filter(entry => keys.has("memo:" + entry.id)
    || sync.revision("memo:" + entry.id) !== (revisions.get(entry.id) || 0)
    || detailSession?.id === entry.id);
  const keepIds = new Set(keep.map(entry => entry.id));
  store.saveMemoAll([...keep, ...entries.filter(entry => !keepIds.has(entry.id)
    && !keys.has("memo:" + entry.id)
    && sync.revision("memo:" + entry.id) === (revisions.get(entry.id) || 0))]);
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
