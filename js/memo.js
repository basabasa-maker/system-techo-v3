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
import * as sync from "./sync.js";
import { toast, showSpinner, hideSpinner } from "./toast.js";
import { todayYmd, nowJst, addDaysYmd } from "./date-util.js";
import { enableLongPressReorder, justDragged } from "./reorder.js";

const state = {
  searchQuery: "",
  sortDesc: true,
  view: "list", // list | detail
  detailId: null,
  draft: null, // まだ保存していない新規メモ
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
    const res = await gas.pullMemoAll("2000-01-01", 2000);
    await applyPulledMemos(res.entries || []);
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
    .addEventListener("click", () => {
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
  // 1行目＝タイトル（無ければ本文の1行目）。2行目＝日時（＋取込済）。本文は出さない
  const text = splitBody(en.body).text;
  const title = en.title || firstLine(text) || "(無題)";
  const when = `${en.date || extractDateFromCreated(en.created_at)} ${extractHhMmFromCreated(en.created_at)}`.trim();
  const taken = takenLabel(en);
  const pin = en.pinned ? `<span class="memo-pin-icon">📌</span>` : "";
  return `
    <div class="memo-row-wrap" data-id="${escapeAttr(en.id)}">
      <div class="memo-row-action memo-row-pin" data-action="pin">${en.pinned ? "ピン解除" : "ピン留め"}</div>
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

// ---------- Detail view（開いたらすぐ書ける） ----------

const ATT_RE = /^\[\[att:([^|\]]+)\|([^|\]]*)\|([^\]]*)\]\]\s*$/;

// 本文を「文字」と「添付」に分ける（添付は本文の末尾に1行ずつ記録している）
function splitBody(body) {
  const lines = String(body || "").split(/\r?\n/);
  const atts = [];
  const text = [];
  for (const ln of lines) {
    const m = ln.match(ATT_RE);
    if (m) atts.push({ id: m[1], name: m[2], mime: m[3] });
    else text.push(ln);
  }
  return { text: text.join("\n").replace(/\s+$/, ""), atts };
}

function joinBody(text, atts) {
  const tokens = atts.map((a) => `[[att:${a.id}|${a.name.replace(/[|\]\n]/g, "_")}|${a.mime}]]`);
  return [text.replace(/\s+$/, ""), ...tokens].filter((x, i) => i === 0 || x).join("\n");
}

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
  const { text } = splitBody(en.body);
  return `
    <div class="memo-detail">
      <div class="memo-detail-header">
        <button class="btn-back" id="d-back">← 戻る</button>
        <span class="memo-detail-time">${escapeHtml(en.date || "")} ${escapeHtml(hhmm)}${taken ? ` ・ ${escapeHtml(taken)}` : ""}</span>
        <span id="d-dbg" class="memo-dbg"></span>
      </div>
      <div class="memo-tools">
        <button class="memo-tool" id="d-check">☑ チェック</button>
        <button class="memo-tool" id="d-attach">📎 添付</button>
        <button class="memo-tool" id="d-copy">コピー</button>
        <button class="memo-tool" id="d-take">取込む</button>
        <input type="file" id="d-file" multiple hidden />
      </div>
      ${en.title ? `<input type="text" id="d-title" class="memo-detail-title-input" value="${escapeAttr(en.title)}" autocomplete="off" placeholder="タイトル" />` : ""}
      <div class="memo-wrap"><textarea id="d-text" class="memo-paper memo-paper-input memo-detail-text" placeholder="ここにメモ" spellcheck="false">${escapeHtml(text)}</textarea><div id="d-strike" class="memo-strike" aria-hidden="true"></div></div>
      <div id="d-atts" class="memo-atts"></div>
      <div class="memo-detail-footer">
        <button class="btn-danger" id="d-delete">削除</button>
      </div>
    </div>
  `;
}

function bindDetail() {
  const en0 = currentEntry();
  if (!en0) {
    const back = rootEl.querySelector("#d-back");
    if (back) back.addEventListener("click", backToList);
    return;
  }
  const ta = rootEl.querySelector("#d-text");
  const titleEl = rootEl.querySelector("#d-title");
  let atts = splitBody(en0.body).atts;
  let saveTimer = null;
  let lastSaved = en0.body || "";

  const strikeEl = rootEl.querySelector("#d-strike");
  // チェック済み（☑）の行に取り消し線を引く。文字は透明で、線だけが入力欄に重なる
  const paintStrike = () => {
    if (!strikeEl) return;
    // カーソル位置（文字を選んでいない、入力中のときだけ描く）
    const pos = document.activeElement === ta && ta.selectionStart === ta.selectionEnd ? ta.selectionStart : -1;
    let off = 0;
    strikeEl.innerHTML = ta.value
      .split("\n")
      .map((ln) => {
        const start = off;
        off += ln.length + 1;
        const at = pos >= start && pos <= start + ln.length ? pos - start : -1;
        // ☑の行は、チェック印（2文字）のあとの文字だけに取り消し線を引く
        const parts = ln.startsWith("☑")
          ? [{ t: ln.slice(0, 2), done: false }, { t: ln.slice(2), done: true }]
          : [{ t: ln, done: false }];
        let idx = 0;
        let placed = false;
        return parts
          .map((pt) => {
            let h = "";
            const end = idx + pt.t.length;
            let body;
            if (at >= 0 && !placed && at >= idx && at <= end) {
              placed = true;
              body = escapeHtml(pt.t.slice(0, at - idx)) + '<span class="caret"></span>' + escapeHtml(pt.t.slice(at - idx));
            } else {
              body = escapeHtml(pt.t);
            }
            h = pt.done ? '<span class="done">' + body + "</span>" : body;
            idx = end;
            return h;
          })
          .join("");
      })
      .join("\n");
  };
  // 入力欄は画面の残りいっぱいに広げ、長いメモは入力欄の中だけでスクロールさせる。
  // （入力欄の下端がキーボードに隠れると、iPhoneが画面ごと持ち上げてしまうため）
  const fit = () => {
    paintStrike();
    syncStrike();
  };
  const syncStrike = () => {
    if (strikeEl) strikeEl.scrollTop = ta.scrollTop;
    if (ta.parentElement) ta.parentElement.style.setProperty("--paper-scroll", -ta.scrollTop + "px");
  };
  ta.addEventListener("scroll", syncStrike, { passive: true });
  const repaintCaret = () => {
    paintStrike();
    syncStrike();
  };
  const onSelChange = () => {
    if (!document.contains(ta)) return document.removeEventListener("selectionchange", onSelChange);
    if (document.activeElement === ta) repaintCaret();
  };
  document.addEventListener("selectionchange", onSelChange);
  ["focus", "blur", "keyup", "click", "touchend"].forEach((ev) => ta.addEventListener(ev, () => setTimeout(repaintCaret, 0)));
  const compose = () => joinBody(ta.value, atts);
  const persist = async () => {
    clearTimeout(saveTimer);
    const cur = currentEntry();
    if (!cur) return;
    const body = compose();
    const title = titleEl ? titleEl.value.trim() : cur.title || "";
    if (body === lastSaved && title === (cur.title || "")) return;
    if (!title && !splitBody(body).text && atts.length === 0 && !findEntry(cur.id)) return; // 空の新規は作らない
    lastSaved = body;
    const next = { ...cur, title, body, updated_at: nowJst(), deleted: 0 };
    delete next._isNew;
    state.draft = next;
    await saveQuiet(next);
  };
  const schedule = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 700);
  };
  detailPersist = persist;

  ta.addEventListener("input", () => {
    fit();
    schedule();
  });
  if (titleEl) titleEl.addEventListener("input", schedule);
  fit();

  // 空の行をタップしたら、その行まで改行を足してカーソルを置く／チェック欄のタップで切り替え
  bindPaperTap(ta, fit, schedule);

  // Enterでチェックを引き継ぐ
  ta.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    const pos = ta.selectionStart;
    const ls = ta.value.lastIndexOf("\n", pos - 1) + 1;
    const line = ta.value.slice(ls, pos);
    const m = line.match(/^([☐☑]) (.*)$/);
    if (!m || ta.selectionEnd !== pos) return;
    e.preventDefault();
    if (!m[2]) {
      // 中身が空のチェック行でEnter → チェックを外す
      ta.value = ta.value.slice(0, ls) + ta.value.slice(pos);
      ta.setSelectionRange(ls, ls);
    } else {
      ta.setRangeText("\n☐ ", pos, pos, "end");
    }
    fit();
    schedule();
  });

  rootEl.querySelector("#d-back").addEventListener("click", async () => {
    await persist();
    backToList();
  });
  rootEl.querySelector("#d-delete").addEventListener("click", () => confirmDelete(state.detailId));
  rootEl.querySelector("#d-take").addEventListener("click", async () => {
    await persist();
    inboxEntry(state.detailId);
  });
  rootEl.querySelector("#d-copy").addEventListener("click", () => copyText(ta.value));
  rootEl.querySelector("#d-check").addEventListener("click", () => {
    const pos = ta.selectionStart;
    const ls = ta.value.lastIndexOf("\n", pos - 1) + 1;
    const head = ta.value.slice(ls, ls + 2);
    if (head === "☐ " || head === "☑ ") {
      ta.setRangeText("", ls, ls + 2, "preserve");
      ta.setSelectionRange(Math.max(ls, pos - 2), Math.max(ls, pos - 2));
    } else {
      ta.setRangeText("☐ ", ls, ls, "preserve");
      ta.setSelectionRange(pos + 2, pos + 2);
    }
    ta.focus();
    fit();
    schedule();
  });

  // 添付
  const fileEl = rootEl.querySelector("#d-file");
  rootEl.querySelector("#d-attach").addEventListener("click", () => fileEl.click());
  fileEl.addEventListener("change", async () => {
    const files = Array.from(fileEl.files || []);
    fileEl.value = "";
    await addFiles(files);
  });
  ta.addEventListener("paste", (e) => {
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
    if (files.length === 0) return; // 文字の貼り付けはそのまま
    e.preventDefault();
    addFiles(files);
  });
  async function addFiles(files) {
    for (const f of files) {
      try {
        showSpinner();
        const up = await uploadFile(f);
        atts = [...atts, up];
        paintAtts();
        await persist();
      } catch (err) {
        toast("添付に失敗：" + err.message, "error");
      } finally {
        hideSpinner();
      }
    }
  }
  function paintAtts() {
    const box = rootEl.querySelector("#d-atts");
    if (!box) return;
    box.innerHTML = "";
    atts.forEach((a, i) => {
      const item = document.createElement("div");
      item.className = "memo-att";
      const rm = document.createElement("button");
      rm.className = "memo-att-rm";
      rm.textContent = "×";
      rm.setAttribute("aria-label", "添付を外す");
      rm.addEventListener("click", () => {
        if (!confirm(`「${a.name}」を外しますか？`)) return;
        atts = atts.filter((_, j) => j !== i);
        paintAtts();
        persist();
      });
      if (/^image\//.test(a.mime)) {
        const img = document.createElement("img");
        img.alt = a.name;
        img.className = "memo-att-img";
        item.appendChild(img);
        loadAttachment(a).then((url) => {
          img.src = url;
          img.addEventListener("click", () => openViewer(url));
        }).catch(() => {
          item.insertBefore(Object.assign(document.createElement("span"), { textContent: "画像を読めません：" + a.name }), rm);
          img.remove();
        });
      } else {
        const b = document.createElement("button");
        b.className = "memo-att-file";
        b.textContent = "📎 " + a.name;
        b.addEventListener("click", async () => {
          try {
            const url = await loadAttachment(a);
            const link = document.createElement("a");
            link.href = url;
            link.download = a.name;
            link.click();
          } catch (err) {
            toast("開けません：" + err.message, "error");
          }
        });
        item.appendChild(b);
      }
      item.appendChild(rm);
      box.appendChild(item);
    });
  }
  paintAtts();
  // 新規メモも、既存メモと同じ見た目・同じ位置で開く。
  // （自動で入力欄を選ぶと、キーボードが出ないまま画面だけ縮んでしまうため、タップで始める）
  bindKeyboardFit(ta, titleEl);
}

// 入力欄を、キーボードが出ても動かない大きさにしておく。
// 書く欄の下端を「キーボードの上端」に合わせて最初から決めるので、
// タップしてもキーボードが出ても、画面の大きさや位置は変わらない（せり上がりが起きない）。
// キーボードの高さは、前回の実測値を覚えて使う
const KB_KEY = "techo-kb-h";
const ACC_H = 64;
function bindKeyboardFit(...fields) {
  const vv = window.visualViewport;
  const wrap = rootEl.querySelector(".memo-detail .memo-wrap");
  if (!wrap) return () => {};
  let kbH = 0;
  try {
    kbH = Number(localStorage.getItem(KB_KEY)) || 0;
  } catch (_) {}
  if (kbH < 200 || kbH > 600) kbH = 340;
  // 書く画面の上端は、一覧のオレンジの線と同じ位置（見出しとタブの真下）にそろえる
  const sc = document.getElementById("scroll-container");
  const detailEl = rootEl.querySelector(".memo-detail");
  const topPx = sc ? Math.round(sc.getBoundingClientRect().top) : 0;
  if (detailEl && sc) detailEl.style.top = topPx + "px";
  const sizeWrap = () => {
    const top = wrap.getBoundingClientRect().top;
    // キーボードの高さ（入力補助バーを含む実測値）の上に収める。一度決めたら、タップ中は変えない
    wrap.style.height = Math.max(120, Math.round(window.innerHeight - top - kbH - 8)) + "px";
  };
  sizeWrap();
  const baseH = window.innerHeight;
  // キーボードの実際の高さを覚える（次回から使う。今の画面は動かさない）
  const learn = () => {
    const real = baseH - vv.height;
    if (real > 200 && real < 600) {
      try {
        localStorage.setItem(KB_KEY, String(Math.round(real)));
      } catch (_) {}
    }
  };
  // 万一iPhoneが画面をずらしたら、すぐ元の位置へ戻す
  const snapBack = () => {
    if (window.scrollY || window.scrollX || document.documentElement.scrollTop) window.scrollTo(0, 0);
  };
  window.addEventListener("scroll", snapBack, { passive: true });
  const detail = rootEl.querySelector(".memo-detail");
  if (vv) vv.addEventListener("resize", learn);
  // キーボードが出る間、iPhoneは見える範囲を一時的に上へずらし、あとで戻す（これが「せり上がり」）。
  // 見出し・タブ・書く画面を含む画面全体を、そのずれと同じだけ毎コマ動かし、見た目の位置を固定する
  const appShell = document.getElementById("app-shell");
  let tracking = false;
  const track = () => {
    if (!tracking) return;
    if (!document.contains(wrap)) {
      tracking = false;
      if (appShell) appShell.style.transform = "";
      return;
    }
    const off = vv ? vv.offsetTop : 0;
    if (appShell) appShell.style.transform = off > 0.5 ? "translateY(" + off + "px)" : "";
    requestAnimationFrame(track);
  };
  const startTrack = () => {
    // 画面全体の補正は、シミュレータの録画で逆に画面を下へずらすと分かったため、通常は使わない（?track=1 のときだけ試せる）
    if (!vv || tracking || !location.search.includes("track=1")) return;
    tracking = true;
    requestAnimationFrame(track);
  };
  const stopTrack = () => {
    tracking = false;
    if (appShell) appShell.style.transform = "";
  };

  // ---- 診断（一時）：タップから2秒間、画面の位置を毎コマ測り、見出しの横に最小・最大を出す ----
  const dbgEl = rootEl.querySelector("#d-dbg");
  let sampling = false;
  const startSample = () => {
    if (!dbgEl || sampling || !vv) return;
    sampling = true;
    const t0 = performance.now();
    const M = {};
    const put = (k, v) => {
      const m = M[k] || (M[k] = { f: v, lo: v, hi: v });
      m.lo = Math.min(m.lo, v);
      m.hi = Math.max(m.hi, v);
      m.l = v;
    };
    let n = 0;
    const tick = () => {
      n++;
      put("innerH", window.innerHeight);
      put("vvH", vv.height);
      put("vvTop", vv.offsetTop);
      put("scrY", window.scrollY);
      put("detVis", detail.getBoundingClientRect().top - vv.offsetTop);
      put("hdrVis", document.getElementById("app-header").getBoundingClientRect().top - vv.offsetTop);
      put("wrapH", wrap.getBoundingClientRect().height);
      put("shellH", document.getElementById("app-shell").getBoundingClientRect().height);
      if (performance.now() - t0 < 2000) return requestAnimationFrame(tick);
      sampling = false;
      const r = (x) => Math.round(x);
      dbgEl.textContent =
        "n=" + n + "\n" +
        Object.keys(M)
          .map((k) => k + " " + r(M[k].f) + (M[k].lo !== M[k].hi ? ">" + r(M[k].lo) + "~" + r(M[k].hi) + ">" : ">") + r(M[k].l))
          .join("\n");
    };
    requestAnimationFrame(tick);
  };
  fields.filter(Boolean).forEach((f) => {
    f.addEventListener("touchstart", () => { startTrack(); startSample(); }, { passive: true });
    f.addEventListener("focus", () => { startTrack(); startSample(); });
    f.addEventListener("blur", () => setTimeout(() => { if (!fields.includes(document.activeElement)) stopTrack(); window.scrollTo(0, 0); }, 80));
  });
  return sizeWrap;
}

let detailPersist = null;

function backToList() {
  state.view = "list";
  state.detailId = null;
  state.draft = null;
  detailPersist = null;
  const shell = document.getElementById("app-shell");
  if (shell) {
    shell.classList.remove("kb-on");
    shell.style.transform = "";
    shell.style.top = "";
    shell.style.bottom = "";
    shell.style.height = "";
  }
  paintRoot();
}

// ---------- 添付ファイル ----------

const attMem = new Map();

async function uploadFile(file) {
  let blob = file;
  let name = file.name || "file";
  let mime = file.type || "application/octet-stream";
  if (/^image\//.test(mime) && mime !== "image/gif") {
    blob = await downscaleImage(file, 1280, 0.72);
    mime = "image/jpeg";
    if (!/\.jpe?g$/i.test(name)) name = name.replace(/\.[^.]*$/, "") + ".jpg";
    if (!name || name === ".jpg") name = "image.jpg";
  }
  if (blob.size > 3 * 1024 * 1024) throw new Error("大きすぎます（3MBまで）");
  const b64 = await blobToBase64(blob);
  const res = await gas.pushMemoAttach(name, mime, b64);
  attMem.set(res.id, URL.createObjectURL(blob));
  return { id: res.id, name: res.name || name, mime: res.mime || mime };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("読み込めません"));
    r.readAsDataURL(blob);
  });
}

function downscaleImage(file, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("画像を変換できません"))), "image/jpeg", quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("画像を読めません"));
    };
    img.src = url;
  });
}

// 一度読んだ添付は端末にも控える（次回から通信しない）
async function loadAttachment(a) {
  if (attMem.has(a.id)) return attMem.get(a.id);
  const key = "/_att/" + a.id;
  try {
    if (window.caches) {
      const cache = await caches.open("sth-att");
      const hit = await cache.match(key);
      if (hit) {
        const url = URL.createObjectURL(await hit.blob());
        attMem.set(a.id, url);
        return url;
      }
    }
  } catch (e) {
    /* 控えが使えなくても続ける */
  }
  const data = await gas.pullMemoAttach(a.id);
  const bin = atob(data.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: data.mime || a.mime });
  try {
    if (window.caches) {
      const cache = await caches.open("sth-att");
      await cache.put(key, new Response(blob, { headers: { "Content-Type": blob.type } }));
    }
  } catch (e) {
    /* ignore */
  }
  const url = URL.createObjectURL(blob);
  attMem.set(a.id, url);
  return url;
}

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

// 罫線の空き行をタップしたら、その行まで改行を足してカーソルを置く。
// 行頭のチェック欄（☐/☑）をタップしたら、チェックを切り替える
function bindPaperTap(ta, fit, schedule) {
  const LINE = 32;
  const PAD = 16;
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
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top + ta.scrollTop;
    const pos = ta.selectionStart;
    const ls = ta.value.lastIndexOf("\n", pos - 1) + 1;
    const mark = ta.value.slice(ls, ls + 2);
    if ((mark === "☐ " || mark === "☑ ") && x < PAD + 44 && pos <= ls + 2) {
      ta.setRangeText(mark === "☐ " ? "☑ " : "☐ ", ls, ls + 2, "preserve");
      schedule();
      return;
    }
    const usedLines = Math.max(1, Math.round(renderedHeight() / LINE));
    const tapLine = Math.floor(y / LINE);
    if (tapLine < usedLines) return; // 文字がある行は、ふつうに位置が決まる
    const add = tapLine - usedLines + 1;
    ta.value = ta.value + "\n".repeat(add);
    const end = ta.value.length;
    ta.setSelectionRange(end, end);
    ta.focus();
    fit();
    schedule();
  });
}

// ---------- Save / Delete / Pin / Inbox ----------

// 書いている最中の自動保存（画面は作り直さない・音も出さない）
async function saveQuiet(entry) {
  store.upsertMemoAllLocal(entry);
  try {
    const saved = await gas.pushMemoUpsert(entry);
    store.upsertMemoAllLocal({ ...saved, body: entry.body, title: entry.title });
  } catch (e) {
    await outbox.enqueue({ type: "memo_upsert", payload: entry });
  }
}

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
      en.claude_taken = nowJst();
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
  if (detailPersist) await detailPersist();
  showSpinner();
  try {
    await flushOutbox().catch(() => {});
    const res = await gas.pullMemoAll("2000-01-01", 2000);
    await applyPulledMemos(res.entries || []);
    if (state.view === "list") paintBody();
    else paintRoot();
    toast("最新化しました" + (await sync.pendingNote()), "success");
  } catch (e) {
    console.error(e);
    toast("取得に失敗しました: " + e.message, "error");
  } finally {
    hideSpinner();
  }
}

async function flushOutbox() {
  return sync.flushAll();
}

// 取得した一覧で手元の一覧を置き換える。ただし、まだ送っていないメモは手元の版を残す
async function applyPulledMemos(entries) {
  const keys = await sync.pendingKeys();
  if (keys.size === 0) {
    store.saveMemoAll(entries);
    return;
  }
  const local = store.loadMemoAll();
  const keep = local.filter((e) => keys.has("memo:" + e.id));
  const keepIds = new Set(keep.map((e) => e.id));
  store.saveMemoAll([...keep, ...entries.filter((e) => !keepIds.has(e.id))]);
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
