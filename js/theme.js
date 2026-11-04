// 背景色の選択（この端末だけに保存。データの同期はしない）
const KEY = "sth_v3_theme";

export const THEMES = [
  { id: "navy", name: "紺", bg: "#1e3a5f", kind: "dark" },
  { id: "black", name: "黒", bg: "#1c1c1e", kind: "dark" },
  { id: "green", name: "深緑", bg: "#1f3b30", kind: "dark" },
  { id: "purple", name: "紫", bg: "#3a2a5c", kind: "dark" },
  { id: "wine", name: "ワイン", bg: "#4a2530", kind: "dark" },
  { id: "brown", name: "茶", bg: "#3d2f26", kind: "dark" },
  { id: "white", name: "白", bg: "#f3f3f0", kind: "light" },
  { id: "cream", name: "クリーム", bg: "#f8efd6", kind: "light" },
  { id: "sky", name: "空色", bg: "#d9eaf8", kind: "light" },
  { id: "mint", name: "ミント", bg: "#d8f0e2", kind: "light" },
  { id: "pink", name: "ピンク", bg: "#fadde6", kind: "light" },
  { id: "lavender", name: "ラベンダー", bg: "#e6e0f7", kind: "light" },
];

export function currentThemeId() {
  try {
    const id = localStorage.getItem(KEY);
    if (THEMES.some((t) => t.id === id)) return id;
  } catch (e) {}
  return "navy";
}

export function applyTheme(id) {
  const t = THEMES.find((x) => x.id === id) || THEMES[0];
  const root = document.documentElement;
  root.dataset.theme = t.id;
  root.dataset.kind = t.kind;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", t.kind === "light" ? "#2b3a4f" : t.bg);
}

export function initTheme() {
  applyTheme(currentThemeId());
  const btn = document.getElementById("btn-theme");
  if (btn) btn.addEventListener("click", openThemePicker);
}

function openThemePicker() {
  const cur = currentThemeId();
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <header>背景色</header>
      <div class="theme-grid">
        ${THEMES.map(
          (t) => `
          <button class="theme-swatch ${t.id === cur ? "on" : ""}" data-id="${t.id}">
            <span class="theme-chip" style="background:${t.bg};color:${t.kind === "light" ? "#22262e" : "#fff"}">${t.id === cur ? "✓" : ""}</span>
            <span>${t.name}</span>
          </button>`,
        ).join("")}
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener("click", (e) => {
    if (e.target === modal) return close();
    const sw = e.target.closest(".theme-swatch");
    if (!sw) return;
    try {
      localStorage.setItem(KEY, sw.dataset.id);
    } catch (err) {}
    applyTheme(sw.dataset.id);
    close();
  });
}
