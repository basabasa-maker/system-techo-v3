// app.js - エントリーポイント
// Sprint 2: Task / Daily を活性化。Memo はプレースホルダ。

import { LS_KEY_ACTIVE_TAB } from "./config.js";
import { renderTaskTab, pullAndRender as pullTask } from "./task.js";
import { renderDailyTab, pullAndRender as pullDaily } from "./daily.js";
import { renderMemoTab, pullAndRender as pullMemo } from "./memo.js";
import { renderHabitTab, pullAndRender as pullHabit } from "./habit.js";
import { renderMealTab, pullAndRender as pullMeal } from "./meal.js";
import { daysAgoYmd } from "./date-util.js";
import { toast } from "./toast.js";
import { initTheme } from "./theme.js";

// 上のタブの並びは index.html の順（デイリー・タスク・習慣・食事・メモ）で固定
const TABS = ["daily", "task", "habit", "meal", "memo"];

const appState = {
  activeTab: localStorage.getItem(LS_KEY_ACTIVE_TAB) || "task",
};

function init() {
  // index.html側で app-shell を事前レンダリング済み（起動時のレイアウトブレ対策）
  // ここではイベントバインドとタブ初期化のみ
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      switchTab(btn.dataset.tab);
    });
  });

  document.getElementById("btn-refresh").addEventListener("click", onRefresh);
  initTheme();

  if (!TABS.includes(appState.activeTab)) appState.activeTab = "task";
  switchTab(appState.activeTab);
}

function switchTab(tab) {
  appState.activeTab = tab;
  localStorage.setItem(LS_KEY_ACTIVE_TAB, tab);
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  const content = document.getElementById("tab-content");
  if (tab === "task") {
    renderTaskTab(content);
  } else if (tab === "daily") {
    renderDailyTab(content);
  } else if (tab === "memo") {
    renderMemoTab(content);
  } else if (tab === "habit") {
    renderHabitTab(content);
  } else if (tab === "meal") {
    renderMealTab(content);
  }
  quietSync(tab);
}

// 開いたとき・タブを切り替えたときに、画面を止めずに最新へ入れ替える
// （習慣・食事・メモは各タブ側で取得済み）
function quietSync(tab) {
  if (tab === "task") pullTask(daysAgoYmd(30), true);
  else if (tab === "daily") pullDaily(true);
}

// 入力を終えたとき、キーボードで生じた画面のずれ（横振れ）を元に戻す
function resetScrollOffset() {
  window.scrollTo(0, 0);
  const sc = document.getElementById("scroll-container");
  if (sc) sc.scrollLeft = 0;
  const shell = document.getElementById("app-shell");
  if (shell) shell.scrollLeft = 0;
}
document.addEventListener("focusout", () => {
  setTimeout(() => {
    const t = document.activeElement && document.activeElement.tagName;
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(t || "")) resetScrollOffset();
  }, 120);
});
window.addEventListener("pageshow", resetScrollOffset);

// アプリに戻ってきたとき、20秒以上離れていれば最新にする
// 入力中・ダイアログ表示中は画面を作り直さない
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    return;
  }
  if (!hiddenAt || Date.now() - hiddenAt < 20000) return;
  hiddenAt = 0;
  const a = document.activeElement;
  const typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
  if (typing || document.querySelector(".modal-backdrop")) return;
  switchTab(appState.activeTab);
});

async function onRefresh() {
  if (appState.activeTab === "task") {
    await pullTask(daysAgoYmd(30));
    return;
  }
  if (appState.activeTab === "daily") {
    await pullDaily();
    return;
  }
  if (appState.activeTab === "memo") {
    await pullMemo();
    return;
  }
  if (appState.activeTab === "habit") {
    await pullHabit();
    return;
  }
  if (appState.activeTab === "meal") {
    await pullMeal();
    return;
  }
  toast("このタブは現在のSprintでは対象外です", "info");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((e) => {
    console.error("SW register failed", e);
  });
}

console.log("system-techo-v3 booted");
