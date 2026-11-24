export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : "g-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}

// フォーカスはユーザーの操作からだけ移す。iPhoneの不要なスクロールを防ぐ。
export function openDialog(title, body, onSubmit, { saveLabel = "保存", onClose, autoFocus = true } = {}) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop goals-modal";
  backdrop.innerHTML = `<form class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
    <header>${escapeHtml(title)}</header><div class="modal-body">${body}<p class="goal-form-error" role="alert" hidden></p></div>
    <footer><button type="button" class="btn-ghost" data-close>キャンセル</button><button type="submit" class="btn-primary" id="g-save">${escapeHtml(saveLabel)}</button></footer></form>`;
  const previous = document.activeElement;
  const close = () => { backdrop.remove(); onClose?.(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  backdrop.querySelector("[data-close]").addEventListener("click", close);
  const showError = (error) => {
    const el = backdrop.querySelector(".goal-form-error");
    el.textContent = error.message || String(error); el.hidden = false;
  };
  backdrop.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    if (event.key !== "Tab") return;
    const fields = Array.from(backdrop.querySelectorAll("button,input,select,textarea,a[href]"))
      .filter((el) => !el.disabled && !el.hidden && el.getClientRects().length);
    if (event.shiftKey && document.activeElement === fields[0]) { event.preventDefault(); fields.at(-1)?.focus({ preventScroll: true }); }
    else if (!event.shiftKey && document.activeElement === fields.at(-1)) { event.preventDefault(); fields[0]?.focus({ preventScroll: true }); }
  });
  backdrop.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = backdrop.querySelector('[type="submit"]');
    if (submit.disabled) return;
    submit.disabled = true;
    try { await onSubmit(backdrop); close(); } catch (error) { showError(error); } finally { submit.disabled = false; }
  });
  document.body.appendChild(backdrop);
  const focus = autoFocus ? backdrop.querySelector("input,textarea,select,button") : backdrop.querySelector("form");
  if (!autoFocus) focus.tabIndex = -1;
  focus?.focus({ preventScroll: true });
  return { element: backdrop, close, showError };
}
