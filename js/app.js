// app.js - エントリーポイント
// Sprint 2: Task / Daily を活性化。Memo はプレースホルダ。

import { LS_KEY_ACTIVE_TAB } from "./config.js";
import { renderTaskTab, pullAndRender as pullTask } from "./task.js";
import { renderDailyTab, pullAndRender as pullDaily } from "./daily.js";
import { renderMemoTab, pullAndRender as pullMemo } from "./memo.js";
import { daysAgoYmd } from "./date-util.js";
import { toast } from "./toast.js";

const TABS = ["task", "daily", "memo"];

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
  }
}

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
