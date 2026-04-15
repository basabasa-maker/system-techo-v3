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
  document.body.innerHTML = `
    <div id="app-shell">
      <header id="app-header">
        <h1>システム手帳</h1>
        <button id="btn-refresh" class="btn-refresh" aria-label="更新">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.65 6.35A7.96 7.96 0 0012 4C7.58 4 4.01 7.58 4.01 12S7.58 20 12 20c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
          更新
        </button>
      </header>
      <nav id="tab-bar">
        <button class="tab-btn" data-tab="task">Task</button>
        <button class="tab-btn" data-tab="daily">Daily</button>
        <button class="tab-btn" data-tab="memo">Memo</button>
      </nav>
      <main id="scroll-container">
        <div id="tab-content"></div>
      </main>
    </div>
  `;

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
