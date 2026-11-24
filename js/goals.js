// 目標の3つの表示。本文・画像バイナリ・同期はそれぞれ専用モジュールへ任せる。
import * as repo from "./goals/repository.js";
import { mountBoard } from "./goals/board.js";
import { escapeHtml as esc, openDialog, uuid } from "./goals/ui.js";
import { loadAttachment, uploadFile } from "./memo/attachments.js";
import { toast } from "./toast.js";
import { nowJst } from "./date-util.js";
import { pendingNote } from "./sync.js";

const state = { view: "goals", purposeId: "", boardGoalId: "", focusItemId: "" };
let root = null;
let mountedBoard = null;
let interactionVersion = 0;
let pullVersion = 0;
let uploadingPhotos = false;

const active = (list) => list.filter((entry) => !entry.deleted);
const ordered = (list) => [...list].sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || String(a.id).localeCompare(String(b.id)));
const options = (list, selected, blank) => `<option value="">${esc(blank)}</option>` + list.map((node) => `<option value="${esc(node.id)}" ${node.id === selected ? "selected" : ""}>${esc(node.title)}</option>`).join("");

export function renderGoalsTab(container) {
  disposeGoalsTab();
  root = container;
  interactionVersion = 0;
  for (const event of ["pointerdown", "keydown", "input"]) root.addEventListener(event, () => interactionVersion++);
  paint();
  pullAndRender(true);
}

export function disposeGoalsTab() {
  mountedBoard?.destroy(); mountedBoard = null;
  document.querySelectorAll(".goals-modal").forEach((dialog) => dialog.remove());
}

function snapshot() { return repo.loadGoals(); }

function paint() {
  if (!root?.isConnected) return;
  mountedBoard?.destroy(); mountedBoard = null;
  let data;
  try { data = snapshot(); } catch (error) {
    root.innerHTML = `<div class="goals-tab"><p class="empty-hint">${esc(error.message)}</p><p class="goal-note">保存済みデータを保護するため、読めないデータは上書きしません。</p></div>`;
    return;
  }
  root.innerHTML = `<div class="goals-tab">
    <div class="goals-view-tabs" role="group" aria-label="目標の表示">
      ${[["purposes", "目的一覧"], ["goals", "目標一覧"], ["board", "ビジョンボード"]].map(([id, label]) => `<button data-goals-view="${id}" aria-pressed="${state.view === id}">${label}</button>`).join("")}
    </div><div id="goals-content"></div>
    <div class="goals-add-menu" id="goals-add-menu" hidden><button id="goals-add-purpose">目的を追加</button><button id="goals-add-goal">目標を追加</button>${state.view === "board" ? '<button id="goals-add-photo">写真を追加</button>' : ""}</div>
    <button class="fab" id="goals-add" aria-label="追加" aria-expanded="false" aria-controls="goals-add-menu">＋</button>
    <p id="goals-sync-status" class="goal-sync-status" role="status"></p>
    <input type="file" id="goals-photo-file" accept="image/*" multiple hidden />
  </div>`;
  root.querySelectorAll("[data-goals-view]").forEach((button) => button.addEventListener("click", () => {
    state.view = button.dataset.goalsView; paint();
  }));
  root.querySelector("#goals-photo-file").addEventListener("change", (event) => {
    const files = Array.from(event.target.files || []); event.target.value = ""; addPhotos(files);
  });
  const add = root.querySelector("#goals-add");
  const menu = root.querySelector("#goals-add-menu");
  const closeMenu = () => { menu.hidden = true; add.setAttribute("aria-expanded", "false"); };
  add.addEventListener("click", () => {
    menu.hidden = !menu.hidden; add.setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) menu.querySelector("button").focus({ preventScroll: true });
  });
  root.querySelector(".goals-tab").addEventListener("click", (event) => {
    if (!event.target.closest(".goals-add-menu,#goals-add")) closeMenu();
  });
  root.querySelector(".goals-tab").addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) { closeMenu(); add.focus({ preventScroll: true }); }
  });
  root.querySelector("#goals-add-purpose").addEventListener("click", () => { closeMenu(); editPurpose(); });
  root.querySelector("#goals-add-goal").addEventListener("click", () => { closeMenu(); editGoal(); });
  const photoAction = root.querySelector("#goals-add-photo");
  if (photoAction) {
    photoAction.disabled = uploadingPhotos;
    photoAction.addEventListener("click", () => { closeMenu(); root.querySelector("#goals-photo-file").click(); });
  }
  if (state.view === "purposes") paintPurposes(data);
  else if (state.view === "board") paintBoard(data);
  else paintGoals(data);
}

function paintPurposes(data) {
  const purposes = ordered(active(data.nodes).filter((node) => node.kind === "purpose"));
  const content = root.querySelector("#goals-content");
  content.innerHTML = `<div class="goals-heading"><h2>目的一覧</h2></div>
    <p class="goal-note">大切にしたい価値観や、生き方を言葉に。</p>
    <div class="purpose-list">${purposes.length ? purposes.map((purpose) => {
      const count = active(data.nodes).filter((node) => node.kind === "goal" && node.parent_id === purpose.id).length;
      return `<article class="purpose-card" data-purpose-id="${esc(purpose.id)}"><span class="goal-eyebrow">目的</span><h3>${esc(purpose.title)}</h3>${purpose.description ? `<p>${esc(purpose.description)}</p>` : ""}<div class="goal-card-actions"><button data-purpose-goals="${esc(purpose.id)}">目標 ${count}件を見る</button><button data-purpose-edit="${esc(purpose.id)}">編集</button></div></article>`;
    }).join("") : `<p class="empty-hint">まだ目的がありません。大切にしたいことから書いてみましょう。</p>`}</div>`;
  content.querySelectorAll("[data-purpose-edit]").forEach((button) => button.addEventListener("click", () => editPurpose(button.dataset.purposeEdit)));
  content.querySelectorAll("[data-purpose-goals]").forEach((button) => button.addEventListener("click", () => {
    state.purposeId = button.dataset.purposeGoals; state.view = "goals"; paint();
  }));
}

function linkedImages(data, goalId) { return active(data.items).filter((item) => item.goal_id === goalId); }
function coverItem(data, goal) { const images = linkedImages(data, goal.id); return images.find((item) => item.id === goal.cover_item_id) || images[0]; }

function paintGoals(data) {
  const nodes = active(data.nodes);
  const purposes = ordered(nodes.filter((node) => node.kind === "purpose"));
  if (!purposes.some((purpose) => purpose.id === state.purposeId)) state.purposeId = "";
  const goals = ordered(nodes.filter((node) => node.kind === "goal" && (!state.purposeId || node.parent_id === state.purposeId)));
  const content = root.querySelector("#goals-content");
  content.innerHTML = `<div class="goals-heading"><h2>目標一覧</h2></div>
    <label class="goal-filter-label"><span class="sr-only">目的で絞り込み</span><select id="goal-purpose-filter">${options(purposes, state.purposeId, "すべての目的")}</select></label>
    <div class="goal-card-list">${goals.length ? goals.map((goal) => {
      const purpose = nodes.find((node) => node.id === goal.parent_id);
      const means = ordered(nodes.filter((node) => node.kind === "means" && node.parent_id === goal.id));
      const cover = coverItem(data, goal);
      return `<article class="goal-card" data-goal-id="${esc(goal.id)}">
        ${cover ? `<button class="goal-cover" data-action="show-board" aria-label="${esc(goal.title)}の画像を見る"><img data-cover-item="${esc(cover.id)}" alt="${esc(cover.caption || cover.name || goal.title)}" /><span class="goal-cover-loading">画像を読み込み中</span></button>` : ""}
        <div class="goal-card-body"><span class="goal-parent-label">目的：${esc(purpose?.title || "参照先の目的がありません")}</span>
        <h3><button data-action="edit-goal">${esc(goal.title)}</button></h3>${goal.description ? `<p class="goal-description">${esc(goal.description)}</p>` : ""}
        <div class="goal-means-preview"><span>手段 ${means.length}件</span>${means.length ? `<ul>${means.slice(0, 3).map((means) => `<li>${esc(means.title)}</li>`).join("")}</ul>` : `<p>目標を達成するための手段を追加できます。</p>`}</div>
        <div class="goal-card-actions"><button data-action="edit-goal">手段を編集</button><button data-action="show-board">ボードで見る</button></div></div></article>`;
    }).join("") : `<div class="empty-hint">まだ目標がありません。${purposes.length ? "目的に沿って、達成したいことを追加しましょう。" : "先に「目的一覧」から、大切にしたいことを追加しましょう。"}</div>`}</div>`;
  content.querySelector("#goal-purpose-filter").addEventListener("change", (event) => { state.purposeId = event.target.value; paint(); });
  content.querySelectorAll(".goal-card").forEach((card) => card.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    const goal = nodes.find((node) => node.id === card.dataset.goalId);
    if (action === "edit-goal") editGoal(goal.id);
    if (action === "show-board") {
      state.boardGoalId = goal.id; state.focusItemId = coverItem(data, goal)?.id || ""; state.view = "board"; paint();
    }
  }));
  content.querySelectorAll("[data-cover-item]").forEach((image) => {
    const item = data.items.find((item) => item.id === image.dataset.coverItem);
    loadAttachment({ id: item.attachment_id, name: item.name, mime: item.mime }).then((url) => {
      if (!image.isConnected) return; image.src = url; image.nextElementSibling?.remove();
    }).catch(() => { if (image.isConnected) image.nextElementSibling.textContent = "画像は通信が戻ると読み込めます"; });
  });
}

function paintBoard(data) {
  const goals = ordered(active(data.nodes).filter((node) => node.kind === "goal"));
  if (!goals.some((goal) => goal.id === state.boardGoalId)) state.boardGoalId = "";
  const board = active(data.boards).find((entry) => entry.id === "vision-main") || repo.defaultBoard();
  const items = active(data.items).filter((item) => item.board_id === board.id && (!state.boardGoalId || item.goal_id === state.boardGoalId));
  const content = root.querySelector("#goals-content");
  content.innerHTML = `<div class="goals-heading"><h2>${esc(board.title || "わたしの未来")}</h2></div>
    <div class="board-controls"><label><span class="sr-only">ボードの目標</span><select id="board-goal-filter">${options(goals, state.boardGoalId, "すべての画像")}</select></label></div>
    <p class="goal-note">写真を長押しで移動。タップでメニュー。余白を動かしてボードを見渡せます。</p>
    <div id="goal-board-mount"></div><div class="board-zoom-controls"><button id="board-zoom-out" aria-label="ボードを縮小">縮小</button><button id="board-fit">全体</button><button id="board-zoom-in" aria-label="ボードを拡大">拡大</button></div>
    <p class="goal-note">写真の追加には通信が必要です。読み込んだ写真はオフラインでも表示できます。</p>`;
  mountedBoard = mountBoard(content.querySelector("#goal-board-mount"), {
    board, items, focusItemId: state.focusItemId,
    onOpenItem: (item) => openPhotoMenu(item.id),
    onSaveItem: async (item) => { const saved = await repo.saveItem(item); updateSyncStatus(); return saved; },
    onError: (error) => toast(error.message, "error"),
  });
  state.focusItemId = "";
  content.querySelector("#board-goal-filter").addEventListener("change", (event) => { state.boardGoalId = event.target.value; paint(); });
  content.querySelector("#board-zoom-out").addEventListener("click", () => mountedBoard.zoomBy(0.8));
  content.querySelector("#board-zoom-in").addEventListener("click", () => mountedBoard.zoomBy(1.25));
  content.querySelector("#board-fit").addEventListener("click", () => mountedBoard.fit());
}

function editPurpose(id) {
  const existing = snapshot().nodes.find((node) => node.id === id);
  openDialog(existing ? "目的を編集" : "目的を追加", `<label>目的<input id="g-title" required maxlength="300" value="${esc(existing?.title || "")}" placeholder="大切にしたい価値観や生き方" /></label><label>説明<textarea id="g-description" rows="4">${esc(existing?.description || "")}</textarea></label>`, async (dialog) => {
    await repo.saveNode({ ...existing, id: existing?.id || uuid(), kind: "purpose", parent_id: "", title: dialog.querySelector("#g-title").value.trim(), description: dialog.querySelector("#g-description").value.trim(), created_at: existing?.created_at || nowJst(), updated_at: nowJst(), deleted: 0 });
    paint(); updateSyncStatus();
  });
}

function editGoal(id) {
  const data = snapshot();
  const existing = data.nodes.find((node) => node.id === id);
  const purposes = ordered(active(data.nodes).filter((node) => node.kind === "purpose"));
  if (!purposes.length) { toast("先に、大切にしたい目的を追加してください", "info"); state.view = "purposes"; paint(); editPurpose(); return; }
  const means = ordered(active(data.nodes).filter((node) => node.kind === "means" && node.parent_id === id));
  const images = id ? linkedImages(data, id) : [];
  const parentId = existing?.parent_id || state.purposeId || purposes[0].id;
  const row = (entry) => `<div class="goal-means-row" data-means-id="${esc(entry?.id || "")}"><input class="goal-means-input" aria-label="手段" maxlength="300" value="${esc(entry?.title || "")}" placeholder="具体的にすること" /><button type="button" data-remove-means aria-label="この手段を削除">削除</button></div>`;
  const modal = openDialog(existing ? "目標と手段を編集" : "目標を追加", `<label>目的<select id="g-parent" required>${options(purposes, parentId, "目的を選択")}</select></label>
    <label>目標<input id="g-title" required maxlength="300" value="${esc(existing?.title || "")}" placeholder="何を達成したいですか" /></label>
    <label>説明<textarea id="g-description" rows="3">${esc(existing?.description || "")}</textarea></label>
    <fieldset class="goal-means-editor"><legend>手段</legend><div id="g-means">${means.length ? means.map(row).join("") : row()}</div><button type="button" class="goal-secondary" id="g-add-means">手段を追加</button></fieldset>
    ${images.length ? `<label>カードの表紙<select id="g-cover">${options(images.map((item) => ({ id: item.id, title: item.caption || item.name || "画像" })), existing?.cover_item_id || "", "関連画像から自動で選ぶ")}</select></label>` : `<p class="goal-note">ボードでこの目標に写真を結びつけると、カードにも同じ写真が表示されます。</p>`}`, async (dialog) => {
    const rows = Array.from(dialog.querySelectorAll(".goal-means-row")).map((el) => ({ id: el.dataset.meansId, removed: el.dataset.removed === "true", title: el.querySelector("input").value.trim() }));
    if (rows.some((entry) => entry.id && !entry.removed && !entry.title)) throw new Error("手段を空にする場合は、その行の「削除」を押してください。");
    const goalId = existing?.id || uuid();
    await repo.saveNode({ ...existing, id: goalId, kind: "goal", parent_id: dialog.querySelector("#g-parent").value, title: dialog.querySelector("#g-title").value.trim(), description: dialog.querySelector("#g-description").value.trim(), cover_item_id: dialog.querySelector("#g-cover")?.value ?? existing?.cover_item_id ?? "", created_at: existing?.created_at || nowJst(), updated_at: nowJst(), deleted: 0 });
    for (let i = 0; i < rows.length; i++) {
      const entry = rows[i]; const old = means.find((means) => means.id === entry.id);
      if (entry.removed) { if (old) await repo.saveNode({ ...old, deleted: 1, updated_at: nowJst() }); }
      else if (entry.title) await repo.saveNode({ ...old, id: old?.id || uuid(), kind: "means", parent_id: goalId, title: entry.title, sort_order: (i + 1) * 10, created_at: old?.created_at || nowJst(), updated_at: nowJst(), deleted: 0 });
    }
    paint(); updateSyncStatus();
  });
  modal.element.querySelector("#g-add-means").addEventListener("click", () => {
    modal.element.querySelector("#g-means").insertAdjacentHTML("beforeend", row());
    modal.element.querySelector("#g-means").lastElementChild.querySelector("input").focus({ preventScroll: true });
  });
  modal.element.querySelector("#g-means").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-means]"); if (!button) return;
    const el = button.closest(".goal-means-row"); el.dataset.removed = "true"; el.hidden = true;
  });
}

async function addPhotos(files) {
  if (!files.length || uploadingPhotos) return;
  uploadingPhotos = true;
  const uploadGoalId = state.boardGoalId;
  const uploadView = root;
  const uploadInteraction = interactionVersion;
  const button = root?.querySelector("#goals-add-photo"); if (button) button.disabled = true;
  let lastId = "";
  let added = 0;
  for (const file of files) {
    try {
      if (!file.type.startsWith("image/")) throw new Error("写真やスクリーンショットの画像を選んでください。");
      const attachment = await uploadFile(file);
      // 通信中の編集や削除を戻さない。画像の参照は最新の状態へ重ねる。
      const data = snapshot();
      let board = active(data.boards).find((board) => board.id === "vision-main") || repo.defaultBoard();
      // 画像のアップロード成功後に参照を作る。失敗した画像だけのカードは残さない。
      const images = active(data.items).filter((entry) => entry.board_id === board.id);
      const index = images.length;
      const x = 60 + (index % 2) * 470;
      // 増えたらボードを伸ばす。上限付近では見える初期位置を再利用する。
      const y = 70 + (Math.floor(index / 2) % 40) * 470;
      const neededHeight = Math.max(board.height, Math.ceil((y + 420 + 70) / 500) * 500);
      if (neededHeight !== board.height || !data.boards.some((entry) => entry.id === board.id && !entry.deleted)) {
        board = await repo.saveBoard({ ...board, height: neededHeight });
      }
      const goal = active(data.nodes).find((node) => node.id === uploadGoalId && node.kind === "goal");
      const item = await repo.saveItem({ id: uuid(), board_id: board.id, attachment_id: attachment.id, name: attachment.name, mime: attachment.mime, x, y, width: 620, height: 420, rotation: index % 2 ? 5 : -4, z_index: images.reduce((max, entry) => Math.max(max, Number(entry.z_index) || 0), 0) + 1, caption: "", goal_id: goal?.id || "", updated_at: nowJst(), deleted: 0 });
      const latestGoal = snapshot().nodes.find((node) => node.id === goal?.id && !node.deleted);
      if (latestGoal && !latestGoal.cover_item_id) await repo.saveNode({ id: latestGoal.id, cover_item_id: item.id });
      lastId = item.id; added++;
    } catch (error) { toast("写真を追加できませんでした：" + error.message, "error"); }
  }
  uploadingPhotos = false;
  if (button?.isConnected) button.disabled = false;
  const currentPhotoAction = root?.querySelector("#goals-add-photo");
  if (currentPhotoAction) currentPhotoAction.disabled = false;
  const sameView = root === uploadView && root?.isConnected && state.view === "board" && state.boardGoalId === uploadGoalId;
  if (added && sameView && interactionVersion === uploadInteraction && !document.querySelector(".goals-modal")) {
    state.focusItemId = lastId; paint(); updateSyncStatus(); if (files.length === 1) editImage(lastId);
  }
}

// 写真タップは操作の選択だけ。移動はboard.jsの長押しで直接始める。
function openPhotoMenu(id) {
  const data = snapshot();
  const item = data.items.find((entry) => entry.id === id && !entry.deleted);
  if (!item) return;
  const goal = data.nodes.find((entry) => entry.id === item.goal_id && !entry.deleted);
  const modal = openDialog("写真のメニュー", `<p class="photo-menu-caption">${esc(item.caption || "この写真の説明はまだありません。")}</p>
    ${goal ? `<p class="goal-note">関連する目標：${esc(goal.title)}</p>` : ""}
    <div class="photo-menu-actions"><button type="button" id="photo-menu-edit">説明・目標を編集</button>
    <button type="button" id="photo-menu-layout">傾き・大きさを変更</button>
    ${goal ? '<button type="button" id="photo-menu-goal">関連する目標を開く</button>' : ""}
    <button type="button" class="photo-menu-danger" id="photo-menu-remove">写真を削除</button></div>`, () => {}, { autoFocus: false });
  modal.element.classList.add("goals-image-sheet", "goals-photo-menu");
  modal.element.querySelector("#g-save").remove();
  const close = modal.element.querySelector("[data-close]");
  close.id = "photo-menu-close"; close.textContent = "閉じる";
  modal.element.querySelector("#photo-menu-edit").addEventListener("click", () => { modal.close(); editImage(id); });
  modal.element.querySelector("#photo-menu-layout").addEventListener("click", () => { modal.close(); editImage(id, { layout: true }); });
  modal.element.querySelector("#photo-menu-goal")?.addEventListener("click", () => {
    modal.close(); state.view = "goals"; state.purposeId = ""; paint(); editGoal(goal.id);
  });
  modal.element.querySelector("#photo-menu-remove").addEventListener("click", async (event) => {
    if (!confirm("この写真をビジョンボードから削除しますか？元の画像ファイルと目標は残ります。")) return;
    event.target.disabled = true;
    try {
      const latest = snapshot();
      const owners = latest.nodes.filter((entry) => !entry.deleted && entry.cover_item_id === id);
      for (const owner of owners) await repo.saveNode({ id: owner.id, cover_item_id: "" });
      await repo.saveItem({ id, deleted: 1 });
      modal.close(); paint(); updateSyncStatus();
    } catch (error) { modal.showError(error); event.target.disabled = false; }
  });
}

function editImage(id, { layout = false } = {}) {
  const data = snapshot();
  const item = data.items.find((item) => item.id === id && !item.deleted);
  if (!item) return;
  const goals = ordered(active(data.nodes).filter((node) => node.kind === "goal"));
  const currentGoal = goals.find((node) => node.id === item.goal_id);
  const modal = openDialog("写真の説明と目標", `<label>説明<textarea id="image-caption" rows="2" placeholder="この写真は、どんな未来を表していますか">${esc(item.caption)}</textarea></label>
    <label>関連する目標<select id="image-goal">${options(goals, item.goal_id, "目標にはまだ結びつけない")}</select></label>
    <details class="image-placement-settings"><summary>配置・表紙の設定</summary>
    <label class="goal-checkbox"><input type="checkbox" id="image-cover" ${currentGoal?.cover_item_id === item.id ? "checked" : ""} />この目標カードの表紙にする</label>
    <label>傾き <output id="image-rotation-value">${Number(item.rotation) || 0}°</output><input id="image-rotation" type="range" min="-45" max="45" step="1" value="${Number(item.rotation) || 0}" /></label>
    <label>大きさ<input id="image-width" type="range" min="160" max="1100" step="10" value="${Number(item.width) || 620}" /></label>
    </details>
    <button type="button" class="goal-secondary" id="image-open-goal" ${currentGoal ? "" : "hidden"}>関連する目標を開く</button>`, async (dialog) => {
    const goalId = dialog.querySelector("#image-goal").value;
    const nextGoal = snapshot().nodes.find((node) => node.id === goalId && !node.deleted);
    const makeCover = dialog.querySelector("#image-cover").checked;
    if (currentGoal?.cover_item_id === item.id && (currentGoal.id !== goalId || !makeCover)) await repo.saveNode({ id: currentGoal.id, cover_item_id: "" });
    const width = Number(dialog.querySelector("#image-width").value);
    await repo.saveItem({ ...item, caption: dialog.querySelector("#image-caption").value.trim(), goal_id: goalId, rotation: Number(dialog.querySelector("#image-rotation").value), width, height: Math.max(40, Math.round(width * item.height / item.width)), updated_at: nowJst() });
    if (nextGoal && makeCover) await repo.saveNode({ id: nextGoal.id, cover_item_id: id });
    paint(); updateSyncStatus();
 }, { autoFocus: false });
  modal.element.classList.add("goals-image-sheet");
  modal.element.querySelector("#g-save").id = "image-save";
  modal.element.querySelector(".image-placement-settings").open = layout;
  modal.element.querySelector("#image-rotation").addEventListener("input", (event) => { modal.element.querySelector("#image-rotation-value").value = event.target.value + "°"; });
  modal.element.querySelector("#image-open-goal").addEventListener("click", () => { const goalId = modal.element.querySelector("#image-goal").value; modal.close(); state.view = "goals"; state.purposeId = ""; paint(); if (goalId) editGoal(goalId); });
  modal.element.querySelector("#image-goal").addEventListener("change", (event) => { modal.element.querySelector("#image-open-goal").hidden = !event.target.value; });

}

async function updateSyncStatus() {
  const target = root?.querySelector("#goals-sync-status");
  const note = await pendingNote();
  if (target?.isConnected) target.textContent = note ? "端末に保存しました" + note : "保存しました";
}

export async function pullAndRender(quiet = false) {
  const view = root;
  const version = ++pullVersion;
  const interactions = interactionVersion;
  try {
    await repo.pullGoals();
    if (version !== pullVersion || view !== root || !view?.isConnected) return;
    if (interactions === interactionVersion && !document.querySelector(".goals-modal")) paint();
    if (!quiet) toast("更新を確認しました" + await pendingNote(), "success");
  } catch (error) {
    if (view !== root || !view?.isConnected) return;
    const status = view.querySelector("#goals-sync-status");
    if (status) status.textContent = "同期できないため、端末に保存した内容を表示しています。";
    if (!quiet) toast("同期できませんでした。端末の記録は保持しています。", "warn");
    console.warn("goals sync skipped:", error.message);
  }
}
