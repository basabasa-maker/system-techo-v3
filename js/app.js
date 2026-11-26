// app.js - エントリーポイント
// 画面の起動と共通イベント。各タブの登録は tabs.js。

import { LS_KEY_ACTIVE_TAB } from "./config.js";
import { TAB_DEFINITIONS, DEFAULT_TAB } from "./tabs.js";
import { toast } from "./toast.js";
import { initTheme } from "./theme.js";
import { initTabNavigation, revealActiveTab } from "./tab-navigation.js";
import { healthBridge } from "./health/bridge.js";
import { showHealthReturnNotice, showHealthSettings } from "./health/ui.js";
import { healthSettingsChanged } from "./habit.js";
import { showAppSettings } from "./settings/ui.js";

// タブの種類。表示順は tab-navigation.js が端末の設定を復元する。
const TABS = Object.keys(TAB_DEFINITIONS);

const appState = {
  activeTab: localStorage.getItem(LS_KEY_ACTIVE_TAB) || DEFAULT_TAB,
};

function init() {
  // index.html側で app-shell を事前レンダリング済み（起動時のレイアウトブレ対策）
  // ここではイベントバインドとタブ初期化のみ
  initTabNavigation(switchTab);

  document.getElementById("btn-refresh").addEventListener("click", onRefresh);
  initTheme();
  document.getElementById("btn-settings").addEventListener("click", () => showAppSettings({
    onOpenHealthSettings: () => showHealthSettings(healthSettingsChanged),
  }));

  if (!TABS.includes(appState.activeTab)) appState.activeTab = DEFAULT_TAB;
  const healthReturn = window.location.hash === "#health-return";
  if (healthReturn) history.replaceState(null,"",window.location.pathname+window.location.search);
  switchTab(appState.activeTab);
  if (healthReturn && !healthBridge.pending()) showHealthReturnNotice();
}

function switchTab(tab) {
  if (!TABS.includes(tab)) return;
  if (TAB_DEFINITIONS[appState.activeTab]?.dispose?.() === false) return;
  appState.activeTab = tab;
  localStorage.setItem(LS_KEY_ACTIVE_TAB, tab);
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  revealActiveTab();
  // タブごとに表示先を分離。前のタブの遅い応答が現在の画面を壊さない。
  const host = document.getElementById("tab-content");
  const content = document.createElement("div");
  content.dataset.tabView = tab;
  host.replaceChildren(content);
  const definition = TAB_DEFINITIONS[tab];
  if (definition) {
    definition.render(content);
    definition.quietSync?.();
  }
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
    const active = document.activeElement;
    if (!active?.isContentEditable && !/^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName || "")) resetScrollOffset();
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
  if (appState.activeTab === "habit" && TAB_DEFINITIONS.habit.resume?.()) return;
  if (!hiddenAt || Date.now() - hiddenAt < 20000) return;
  hiddenAt = 0;
  const a = document.activeElement;
  const typing = a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  if (typing || document.querySelector(".modal-backdrop")) return;
  switchTab(appState.activeTab);
});

window.addEventListener("pageshow", () => {
  if (appState.activeTab === "habit") TAB_DEFINITIONS.habit.resume?.();
});
window.addEventListener("focus", () => {
  if (appState.activeTab === "habit") TAB_DEFINITIONS.habit.resume?.();
});

async function onRefresh() {
  const definition = TAB_DEFINITIONS[appState.activeTab];
  if (definition) {
    await definition.refresh();
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
