// 一時的な診断用（原因特定のあと削除する）。メモ入力欄を触ったあと1.4秒の位置の変化を画面に出す
(function () {
  const vv = window.visualViewport;
  if (!vv) return;
  const box = document.createElement("pre");
  box.style.cssText =
    "position:fixed;left:0;top:250px;z-index:99999;background:#000c;color:#0f0;font:9px/1.15 monospace;margin:0;padding:2px;max-width:100%;white-space:pre-wrap;pointer-events:none";
  document.documentElement.appendChild(box);
  let rec = false, t0 = 0, rows = [], last = "";
  const snap = (tag) => {
    const sh = document.getElementById("app-shell");
    const sc = document.getElementById("scroll-container");
    const b = document.body.getBoundingClientRect();
    const r = sh ? sh.getBoundingClientRect() : { top: -1, height: -1 };
    const v = [
      "vvT", Math.round(vv.offsetTop), "vvH", Math.round(vv.height), "inH", innerHeight,
      "shT", Math.round(r.top), "shH", Math.round(r.height), "bdT", Math.round(b.top),
      "sY", Math.round(scrollY), "dE", document.scrollingElement ? Math.round(document.scrollingElement.scrollTop) : -1,
      "sc", sc ? Math.round(sc.scrollTop) : -1,
    ].join(" ");
    if (v !== last || tag !== "f") rows.push(Math.round(performance.now() - t0) + " " + tag + " " + v);
    last = v;
  };
  const loop = () => {
    if (!rec) return;
    snap("f");
    if (performance.now() - t0 < 1400) requestAnimationFrame(loop);
    else { rec = false; box.textContent = rows.slice(0, 45).join("\n"); }
  };
  document.addEventListener("touchstart", (e) => {
    if (e.target && e.target.id === "d-text" && !rec) { rec = true; rows = []; last = ""; t0 = performance.now(); snap("touch"); requestAnimationFrame(loop); }
  }, true);
  document.addEventListener("focusin", () => { if (rec) snap("focusin"); }, true);
  window.addEventListener("scroll", () => { if (rec) snap("WINSCROLL"); });
  vv.addEventListener("resize", () => { if (rec) snap("vvRESIZE"); });
  vv.addEventListener("scroll", () => { if (rec) snap("vvSCROLL"); });
  document.addEventListener("touchstart", () => { if (!rec) box.textContent = ""; }, true);
})();
