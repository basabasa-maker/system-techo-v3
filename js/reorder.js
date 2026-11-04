// reorder.js - 長押しで行を動かす共通部品（習慣・タスク・Memo・上のタブで共用）
// 使い方: enableLongPressReorder(listEl, { itemSelector, onReorder(ids), axis })
// - 約0.45秒押し続けると持ち上がる。そのまま動かして離すと確定
// - axis: "y"（既定・縦に並ぶ行）/ "x"（横に並ぶ上のタブ）
// - 押し始めてから指が8px以上動いたら、通常のスクロールとみなして長押しを取り消す
// - ids は並べ替え後の data-id の配列
// - タッチ（iPhone）とマウス（PC確認用）の両方に対応

const HOLD_MS = 450;
const MOVE_CANCEL_PX = 8;
const EDGE_PX = 70;
const SCROLL_STEP = 10;

export function enableLongPressReorder(listEl, opts) {
  const itemSelector = opts.itemSelector;
  const onReorder = opts.onReorder;
  const ignoreSelector = opts.ignoreSelector || "";
  const horizontal = opts.axis === "x";
  const scroller = document.getElementById("scroll-container");

  let timer = null;
  let startX = 0;
  let startY = 0;
  let dragging = false;
  let item = null;
  let ghost = null;
  let grabOffset = 0;
  let lastPos = 0;
  let scrollTimer = null;

  const pos = (x, y) => (horizontal ? x : y);

  function cleanup() {
    clearTimeout(timer);
    timer = null;
    clearInterval(scrollTimer);
    scrollTimer = null;
    if (ghost) ghost.remove();
    ghost = null;
    if (item) item.classList.remove("reorder-placeholder");
    listEl.classList.remove("reorder-active");
    item = null;
    dragging = false;
  }

  function begin(el) {
    item = el;
    dragging = true;
    const rect = el.getBoundingClientRect();
    grabOffset = horizontal ? startX - rect.left : startY - rect.top;
    ghost = el.cloneNode(true);
    ghost.classList.add("reorder-ghost");
    ghost.style.position = "fixed";
    ghost.style.left = rect.left + "px";
    ghost.style.width = rect.width + "px";
    ghost.style.height = rect.height + "px";
    ghost.style.top = rect.top + "px";
    ghost.style.margin = "0";
    ghost.style.pointerEvents = "none";
    ghost.style.zIndex = "200";
    document.body.appendChild(ghost);
    el.classList.add("reorder-placeholder");
    listEl.classList.add("reorder-active");
    // すでに選択が始まっていたら解除する
    try {
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.removeAllRanges) sel.removeAllRanges();
    } catch (err) {
      /* 解除できなくても続行 */
    }
    if (navigator.vibrate) {
      try {
        navigator.vibrate(15);
      } catch (e) {
        /* 非対応は無視 */
      }
    }
    if (!horizontal) scrollTimer = setInterval(autoScroll, 30);
  }

  function siblings() {
    return Array.from(listEl.querySelectorAll(itemSelector)).filter(
      (n) => n !== item,
    );
  }

  function move(p) {
    lastPos = p;
    if (!ghost || !item) return;
    if (horizontal) ghost.style.left = p - grabOffset + "px";
    else ghost.style.top = p - grabOffset + "px";
    const size = horizontal ? ghost.offsetWidth : ghost.offsetHeight;
    const center = p - grabOffset + size / 2;
    let placed = false;
    for (const sib of siblings()) {
      const r = sib.getBoundingClientRect();
      const mid = horizontal ? r.left + r.width / 2 : r.top + r.height / 2;
      if (center < mid) {
        if (item.nextElementSibling !== sib) sib.parentNode.insertBefore(item, sib);
        placed = true;
        break;
      }
    }
    if (!placed) {
      const sibs = siblings();
      const last = sibs[sibs.length - 1];
      if (last && last.nextElementSibling !== item) {
        last.parentNode.insertBefore(item, last.nextElementSibling);
      }
    }
  }

  function autoScroll() {
    if (!dragging || !scroller) return;
    const r = scroller.getBoundingClientRect();
    if (lastPos < r.top + EDGE_PX) scroller.scrollTop -= SCROLL_STEP;
    else if (lastPos > r.bottom - EDGE_PX) scroller.scrollTop += SCROLL_STEP;
    move(lastPos);
  }

  function finish() {
    if (!dragging) {
      cleanup();
      return;
    }
    const ids = Array.from(listEl.querySelectorAll(itemSelector)).map(
      (n) => n.dataset.id || n.dataset.tab,
    );
    cleanup();
    lastDragEnd = Date.now();
    onReorder(ids);
  }

  function down(e, x, y) {
    const el = e.target.closest(itemSelector);
    if (!el || !listEl.contains(el)) return false;
    if (ignoreSelector && e.target.closest(ignoreSelector)) return false;
    startX = x;
    startY = y;
    lastPos = pos(x, y);
    clearTimeout(timer);
    timer = setTimeout(() => begin(el), HOLD_MS);
    return true;
  }

  function movedTooFar(x, y) {
    return (
      Math.abs(x - startX) > MOVE_CANCEL_PX ||
      Math.abs(y - startY) > MOVE_CANCEL_PX
    );
  }

  // ---- タッチ ----
  listEl.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      down(e, e.touches[0].clientX, e.touches[0].clientY);
    },
    { passive: true },
  );
  listEl.addEventListener(
    "touchmove",
    (e) => {
      const t = e.touches[0];
      if (dragging) {
        e.preventDefault(); // 持ち上げ中は画面スクロールさせない
        move(pos(t.clientX, t.clientY));
        return;
      }
      if (timer && movedTooFar(t.clientX, t.clientY)) {
        clearTimeout(timer);
        timer = null;
      }
    },
    { passive: false },
  );
  listEl.addEventListener("touchend", finish);
  listEl.addEventListener("touchcancel", cleanup);
  // 長押し後の文字選択・メニューを出さない（iPhoneは長押しで文字選択が始まるため、
  // 押している間は選択の開始そのものを止める）
  listEl.addEventListener("contextmenu", (e) => {
    if (dragging || timer) e.preventDefault();
  });
  listEl.addEventListener("selectstart", (e) => {
    if (dragging || timer) e.preventDefault();
  });

  // ---- マウス（PCでの確認用） ----
  listEl.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    down(e, e.clientX, e.clientY);
  });
  window.addEventListener("mousemove", (e) => {
    if (dragging) {
      move(pos(e.clientX, e.clientY));
      return;
    }
    if (timer && movedTooFar(e.clientX, e.clientY)) {
      clearTimeout(timer);
      timer = null;
    }
  });
  window.addEventListener("mouseup", () => {
    if (dragging) finish();
    else {
      clearTimeout(timer);
      timer = null;
    }
  });
}

// 並べ替えを終えた直後（0.4秒以内）に起きる「タップ」を無視するための判定
let lastDragEnd = 0;
export function justDragged() {
  return Date.now() - lastDragEnd < 400;
}
