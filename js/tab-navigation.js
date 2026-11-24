// タブ列だけを横スクロールし、長押しの順序を端末に保存する。
import { enableLongPressReorder, justDragged } from "./reorder.js";

export const TAB_ORDER_KEY = "sth_v3_tab_order";

export function sanitizeTabOrder(saved, available) {
  const seen = new Set();
  return [...(Array.isArray(saved) ? saved : []), ...available].filter((id) => {
    if (!available.includes(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function initTabNavigation(onSelect) {
  const bar = document.getElementById("tab-bar");
  const buttons = Array.from(bar.querySelectorAll(".tab-btn"));
  const byId = new Map(buttons.map((button) => [button.dataset.tab, button]));
  let stored = [];
  try { stored = JSON.parse(localStorage.getItem(TAB_ORDER_KEY) || "[]"); } catch (_) {}
  for (const id of sanitizeTabOrder(stored, [...byId.keys()])) bar.appendChild(byId.get(id));
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      if (!button.disabled && !justDragged()) onSelect(button.dataset.tab);
    });
    // キーボードでも順序を変えられる。通常の矢印はスクロールへ残す。
    button.addEventListener("keydown", (event) => {
      if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const neighbor = event.key === "ArrowLeft" ? button.previousElementSibling : button.nextElementSibling;
      if (!neighbor) return;
      if (event.key === "ArrowLeft") bar.insertBefore(button, neighbor);
      else bar.insertBefore(neighbor, button);
      persist();
      button.focus({ preventScroll: true });
      revealActiveTab();
    });
  });
  function persist() {
    try {
      localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(Array.from(bar.querySelectorAll(".tab-btn"), (b) => b.dataset.tab)));
    } catch (_) { /* 並びの保存不可でも既存データには触らない */ }
  }
  enableLongPressReorder(bar, { itemSelector: ".tab-btn", axis: "x", onReorder: persist });
}

export function revealActiveTab() {
  const bar = document.getElementById("tab-bar");
  const active = bar.querySelector(".tab-btn.active");
  if (!active) return;
  const left = active.offsetLeft;
  if (left < bar.scrollLeft) bar.scrollLeft = left;
  else if (left + active.offsetWidth > bar.scrollLeft + bar.clientWidth) {
    bar.scrollLeft = left + active.offsetWidth - bar.clientWidth;
  }
}
