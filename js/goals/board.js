// Free board coordinates stay independent of the current viewport and zoom.
// Only a completed photo move is persisted; pan/zoom are local viewing state.
import { loadAttachment } from "../memo/attachments.js";

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;
const MOVE_THRESHOLD = 7;
const HOLD_MS = 450;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function mountBoard(container, options = {}) {
  const board = options.board || {};
  const worldWidth = Math.max(1, finite(board.width, 1200));
  const worldHeight = Math.max(1, finite(board.height, 1600));
  const records = new Map((options.items || []).filter((item) => !item.deleted)
    .map((item) => [String(item.id), { ...item }]));
  const elements = new Map();
  const versions = new Map();
  const pointers = new Map();
  const events = new AbortController();
  let destroyed = false;
  let gesture = null;
  let holdTimer = null;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let selectedId = String(options.focusItemId || "");
  let suppressClickUntil = 0;
  let frame = 0;
  let fitted = false;

  const viewport = document.createElement("div");
  viewport.className = "board-viewport";
  viewport.tabIndex = 0;
  viewport.setAttribute("role", "region");
  viewport.style.touchAction = "none";
  viewport.style.overflow = "hidden";
  const stage = document.createElement("div");
  stage.className = "board-stage";
  stage.style.width = worldWidth + "px";
  stage.style.height = worldHeight + "px";
  stage.style.transformOrigin = "0 0";
  viewport.appendChild(stage);
  container.replaceChildren(viewport);

  function report(error) {
    if (!destroyed && typeof options.onError === "function") options.onError(error);
  }

  function openItem(item) {
    if (!destroyed && viewport.isConnected && typeof options.onOpenItem === "function") {
      options.onOpenItem({ ...item });
    }
  }

  function paintPhoto(element, item) {
    element.style.left = finite(item.x, 0) + "px";
    element.style.top = finite(item.y, 0) + "px";
    element.style.width = Math.max(1, finite(item.width, 550)) + "px";
    element.style.height = Math.max(1, finite(item.height, 400)) + "px";
    element.style.transform = "rotate(" + finite(item.rotation, 0) + "deg)";
    element.style.zIndex = String(finite(item.z_index, 0));
    element.classList.toggle("is-selected", String(item.id) === selectedId);
  }

  function select(id) {
    selectedId = String(id || "");
    for (const [key, element] of elements) element.classList.toggle("is-selected", key === selectedId);
  }

  function constrainPosition(item) {
    return {
      ...item,
      x: clamp(finite(item.x, 0), 0, Math.max(0, worldWidth - finite(item.width, 550))),
      y: clamp(finite(item.y, 0), 0, Math.max(0, worldHeight - finite(item.height, 400))),
    };
  }

  async function commitItem(item, previous) {
    const id = String(item.id);
    const version = (versions.get(id) || 0) + 1;
    versions.set(id, version);
    records.set(id, item);
    const element = elements.get(id);
    if (element) paintPhoto(element, item);
    try {
      const saved = typeof options.onSaveItem === "function" ? await options.onSaveItem({ ...item }) : item;
      if (destroyed || versions.get(id) !== version) return;
      const next = saved && saved.id ? { ...saved } : item;
      records.set(id, next);
      if (element) paintPhoto(element, next);
    } catch (error) {
      if (destroyed) return;
      if (versions.get(id) === version) {
        records.set(id, previous);
        if (element) paintPhoto(element, previous);
      }
      report(error);
    }
  }

  for (const [id, item] of records) {
    const photo = document.createElement("button");
    photo.type = "button";
    photo.className = "board-photo board-photo-loading";
    photo.dataset.itemId = id;
    photo.setAttribute("aria-label", (item.name || "写真") + "のメニューを開く");
    photo.title = item.caption || item.name || "写真";
    paintPhoto(photo, item);
    const image = document.createElement("img");
    image.className = "board-image";
    image.alt = item.caption || item.name || "ビジョンボードの写真";
    image.draggable = false;
    const pin = document.createElement("img");
    pin.className = "board-pin";
    pin.src = "icons/goal-pin.png";
    pin.alt = "";
    pin.setAttribute("aria-hidden", "true");
    pin.draggable = false;
    photo.append(image, pin);
    stage.appendChild(photo);
    elements.set(id, photo);
    const attachment = { id: item.attachment_id, name: item.name, mime: item.mime };
    const imageError = () => {
      if (destroyed || !photo.isConnected || photo.classList.contains("board-photo-error")) return;
      photo.classList.remove("board-photo-loading");
      photo.classList.add("board-photo-error");
      const hint = document.createElement("span");
      hint.className = "board-image-error";
      hint.textContent = "画像を表示できません。接続して更新してください。";
      photo.appendChild(hint);
    };
    image.addEventListener("load", () => photo.classList.remove("board-photo-loading"), { signal: events.signal });
    image.addEventListener("error", imageError, { signal: events.signal });
    loadAttachment(attachment).then((url) => {
      if (!destroyed && photo.isConnected) image.src = url;
    }).catch(imageError);
    photo.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Pointer taps are handled at pointerup; detail=0 also supports assistive clicks.
      if (event.detail === 0 && Date.now() > suppressClickUntil) {
        select(id);
        openItem(records.get(id));
      }
    }, { signal: events.signal });
    photo.addEventListener("keydown", (event) => {
      if (["Enter", " "].includes(event.key)) {
        event.preventDefault();
        select(id);
        openItem(records.get(id));
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const old = records.get(id);
      const step = event.shiftKey ? 50 : 10;
      const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
      const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
      select(id);
      commitItem(constrainPosition({ ...old, x: finite(old.x, 0) + dx, y: finite(old.y, 0) + dy }), old);
    }, { signal: events.signal });
  }

  if (records.size === 0) {
    const empty = document.createElement("div");
    empty.className = "board-empty";
    empty.textContent = "未来のイメージを、ここに貼ってみましょう。";
    empty.style.pointerEvents = "none";
    viewport.appendChild(empty);
  }

  function keepBoardVisible() {
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    const scaledWidth = worldWidth * scale;
    const scaledHeight = worldHeight * scale;
    offsetX = scaledWidth < width ? (width - scaledWidth) / 2 : clamp(offsetX, width - scaledWidth - 60, 60);
    offsetY = scaledHeight < height ? (height - scaledHeight) / 2 : clamp(offsetY, height - scaledHeight - 60, 60);
  }

  function transform() {
    keepBoardVisible();
    stage.style.transform = "translate(" + offsetX + "px," + offsetY + "px) scale(" + scale + ")";
    viewport.dataset.zoom = String(scale);
  }

  function fit() {
    if (destroyed || !viewport.clientWidth) return scale;
    scale = clamp(viewport.clientWidth / worldWidth, MIN_ZOOM, MAX_ZOOM);
    offsetX = (viewport.clientWidth - worldWidth * scale) / 2;
    offsetY = 0;
    const focus = records.get(String(options.focusItemId || ""));
    if (focus) {
      offsetX = viewport.clientWidth / 2 - (finite(focus.x, 0) + finite(focus.width, 550) / 2) * scale;
      offsetY = viewport.clientHeight / 2 - (finite(focus.y, 0) + finite(focus.height, 400) / 2) * scale;
    }
    fitted = true;
    transform();
    return scale;
  }

  function clearHold() {
    clearTimeout(holdTimer);
    holdTimer = null;
  }

  function rollbackDraft() {
    if (gesture?.kind !== "photo") return;
    const element = elements.get(gesture.id);
    records.set(gesture.id, gesture.previous);
    if (element) {
      element.classList.remove("is-held", "is-dragging");
      paintPhoto(element, gesture.previous);
    }
  }

  function cancelGesture() {
    clearHold();
    rollbackDraft();
    gesture = null;
    const captured = [...pointers.keys()];
    pointers.clear();
    for (const id of captured) {
      try { viewport.releasePointerCapture(id); } catch (_) {}
    }
    viewport.classList.remove("is-panning", "is-holding");
    suppressClickUntil = Date.now() + 450;
  }

  function zoomAt(nextScale, x, y) {
    const next = clamp(nextScale, MIN_ZOOM, MAX_ZOOM);
    const worldX = (x - offsetX) / scale;
    const worldY = (y - offsetY) / scale;
    offsetX = x - worldX * next;
    offsetY = y - worldY * next;
    scale = next;
    transform();
  }

  function zoomBy(factor) {
    cancelGesture();
    zoomAt(scale * finite(factor, 1), viewport.clientWidth / 2, viewport.clientHeight / 2);
    return scale;
  }

  function startPinch() {
    clearHold();
    rollbackDraft();
    viewport.classList.remove("is-holding");
    const [a, b] = [...pointers.values()];
    const rect = viewport.getBoundingClientRect();
    const x = (a.x + b.x) / 2 - rect.left;
    const y = (a.y + b.y) / 2 - rect.top;
    gesture = {
      kind: "pinch", distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), scale,
      worldX: (x - offsetX) / scale, worldY: (y - offsetY) / scale,
    };
    suppressClickUntil = Date.now() + 450;
  }

  viewport.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try { viewport.setPointerCapture(event.pointerId); } catch (_) {}
    if (pointers.size >= 2) { startPinch(); return; }
    const photo = event.target.closest(".board-photo");
    const id = photo && stage.contains(photo) ? photo.dataset.itemId : null;
    if (id) {
      select(id);
      photo.focus({ preventScroll: true });
    }
    gesture = {
      kind: id ? "pending" : "pan", id, previous: id ? { ...records.get(id) } : null,
      startX: event.clientX, startY: event.clientY, offsetX, offsetY, moved: false,
    };
    if (id) {
      const pending = gesture;
      holdTimer = setTimeout(() => {
        holdTimer = null;
        if (destroyed || !viewport.isConnected || gesture !== pending || pointers.size !== 1) return;
        pending.kind = "photo";
        const element = elements.get(id);
        element.classList.add("is-held", "is-dragging");
        viewport.classList.add("is-holding");
        suppressClickUntil = Date.now() + HOLD_MS;
      }, HOLD_MS);
    }
  }, { signal: events.signal });

  viewport.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId) || !gesture) return;
    event.preventDefault();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (gesture.kind === "pinch" && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const rect = viewport.getBoundingClientRect();
      scale = clamp(gesture.scale * Math.hypot(a.x - b.x, a.y - b.y) / gesture.distance, MIN_ZOOM, MAX_ZOOM);
      offsetX = (a.x + b.x) / 2 - rect.left - gesture.worldX * scale;
      offsetY = (a.y + b.y) / 2 - rect.top - gesture.worldY * scale;
      transform();
      return;
    }
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    const distance = Math.hypot(dx, dy);
    if (gesture.kind === "pending") {
      if (distance < MOVE_THRESHOLD) return;
      clearHold();
      gesture.kind = "pan";
    }
    // After the hold, follow even small movements. Before the hold, movement pans.
    if (!gesture.moved && distance < (gesture.kind === "photo" ? 0.5 : MOVE_THRESHOLD)) return;
    gesture.moved = true;
    if (gesture.kind === "photo") {
      const next = constrainPosition({ ...gesture.previous,
        x: finite(gesture.previous.x, 0) + dx / scale,
        y: finite(gesture.previous.y, 0) + dy / scale });
      records.set(gesture.id, next);
      const element = elements.get(gesture.id);
      element.classList.add("is-dragging");
      paintPhoto(element, next);
    } else {
      offsetX = gesture.offsetX + dx;
      offsetY = gesture.offsetY + dy;
      viewport.classList.add("is-panning");
      transform();
    }
  }, { passive: false, signal: events.signal });

  viewport.addEventListener("pointerup", (event) => {
    if (!pointers.has(event.pointerId)) return;
    event.preventDefault();
    clearHold();
    pointers.delete(event.pointerId);
    try { viewport.releasePointerCapture(event.pointerId); } catch (_) {}
    const completed = gesture;
    gesture = null;
    viewport.classList.remove("is-panning", "is-holding");
    suppressClickUntil = Date.now() + 450;
    if (!completed) return;
    if (completed.kind === "pinch") {
      if (pointers.size >= 2) startPinch();
      else if (pointers.size) {
        const remaining = [...pointers.values()][0];
        gesture = { kind: "pan", startX: remaining.x, startY: remaining.y, offsetX, offsetY, moved: true };
      }
      return;
    }
    if (completed.kind === "photo") {
      elements.get(completed.id)?.classList.remove("is-held", "is-dragging");
      const moved = records.get(completed.id);
      if (completed.moved && (moved.x !== completed.previous.x || moved.y !== completed.previous.y)) {
        commitItem(moved, completed.previous);
      }
      return; // A held photo never also opens its tap menu.
    }
    if (completed.kind === "pending" && !completed.moved && completed.id) openItem(records.get(completed.id));
  }, { signal: events.signal });

  viewport.addEventListener("pointercancel", cancelGesture, { signal: events.signal });
  viewport.addEventListener("lostpointercapture", (event) => {
    if (pointers.has(event.pointerId)) cancelGesture();
  }, { signal: events.signal });
  viewport.addEventListener("contextmenu", (event) => event.preventDefault(), { signal: events.signal });
  viewport.addEventListener("dragstart", (event) => event.preventDefault(), { signal: events.signal });
  viewport.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { cancelGesture(); return; }
    if (event.target !== viewport) return;
    if (["+", "="].includes(event.key)) { event.preventDefault(); zoomBy(1.2); }
    if (event.key === "-") { event.preventDefault(); zoomBy(1 / 1.2); }
    const shift = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }[event.key];
    if (shift) { event.preventDefault(); offsetX += shift[0]; offsetY += shift[1]; transform(); }
  }, { signal: events.signal });

  // Kept for callers from the previous API; moving photos no longer needs a mode.
  function setEditMode() {}
  viewport.dataset.boardMode = "view";
  viewport.setAttribute("aria-label", "ビジョンボード。写真を長押しして移動。短くタップしてメニューを開く。ドラッグでボード移動、2本指で拡大縮小。");

  let observer = null;
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => {
      if (destroyed || !viewport.isConnected) return;
      if (!fitted) fit();
      else transform();
    });
    observer.observe(viewport);
  }
  fit();
  frame = requestAnimationFrame(() => { if (!destroyed && !fitted) fit(); });

  return {
    fit, zoomBy, setEditMode,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelGesture();
      events.abort();
      observer?.disconnect();
      cancelAnimationFrame(frame);
      viewport.remove();
    },
  };
}
