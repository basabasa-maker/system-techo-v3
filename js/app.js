// app.js - エントリーポイント
// Sprint 1: Task タブ実装。Daily / Memo はプレースホルダ。

import { LS_KEY_ACTIVE_TAB } from "./config.js";
import { renderTaskTab, pullAndRender } from "./task.js";
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
        <button id="btn-refresh" class="btn-refresh" aria-label="更新">⟳</button>
      </header>
      <nav id="tab-bar">
        <button class="tab-btn" data-tab="task">Task</button>
        <button class="tab-btn" data-tab="daily" disabled>Daily</button>
        <button class="tab-btn" data-tab="memo" disabled>Memo</button>
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
  } else {
    content.innerHTML = `<p class="empty-hint">「${tab}」タブは Sprint ${tab === "daily" ? 2 : 3} で実装予定です。</p>`;
  }
}

async function onRefresh() {
  if (appState.activeTab === "task") {
    await pullAndRender(daysAgoYmd(30));
    return;
  }
  toast("このタブは Sprint 1 では対象外です", "info");
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
