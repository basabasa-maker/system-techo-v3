// toast.js - 簡易トースト通知とローディングスピナー

let toastRoot = null;
let spinnerEl = null;
let spinnerCount = 0;

function ensureRoot() {
  if (toastRoot) return toastRoot;
  toastRoot = document.createElement("div");
  toastRoot.id = "toast-root";
  document.body.appendChild(toastRoot);
  return toastRoot;
}

export function toast(message, kind = "info") {
  const root = ensureRoot();
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add("toast-fadeout");
    setTimeout(() => el.remove(), 300);
  }, 2500);
}

function ensureSpinner() {
  if (spinnerEl) return spinnerEl;
  spinnerEl = document.createElement("div");
  spinnerEl.id = "spinner-root";
  spinnerEl.innerHTML = '<div class="spinner"></div>';
  spinnerEl.style.display = "none";
  document.body.appendChild(spinnerEl);
  return spinnerEl;
}

export function showSpinner() {
  ensureSpinner();
  spinnerCount++;
  spinnerEl.style.display = "flex";
}

export function hideSpinner() {
  spinnerCount = Math.max(0, spinnerCount - 1);
  if (spinnerCount === 0 && spinnerEl) {
    spinnerEl.style.display = "none";
  }
}
