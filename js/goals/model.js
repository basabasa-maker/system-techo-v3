// Goals-only contracts. No DOM, browser storage or network side effects.
export const CACHE_KEY = "sth_v3_goals_cache";
export const DEFAULT_BOARD = Object.freeze({
  id: "vision-main", title: "わたしの未来", background: "cork",
  width: 1200, height: 1600, deleted: 0,
});

export const ENTITY_GROUPS = Object.freeze({
  nodes: "goal_node:", boards: "goal_board:", items: "goal_item:",
});

export function isDeleted(record) {
  return record?.deleted === true || Number(record?.deleted) === 1;
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + "の形式が正しくありません");
  }
  return value;
}

function text(value) { return value == null ? "" : String(value); }
function id(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value)) throw new Error(label + "が正しくありません");
  return value;
}
function optionalId(value, label) {
  return value == null || value === "" ? "" : id(value, label);
}
function flag(value) {
  if (value == null || value === "") return 0;
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0") return 0;
  throw new Error("削除状態が正しくありません");
}
function number(value, fallback, min, max, label) {
  const n = value == null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(label + "が正しくありません");
  return n;
}

// Missing entity groups are allowed for forward-compatible local metadata, but
// malformed groups/rows are never silently dropped and written back as empty.
export function goalSnapshot(value = {}) {
  record(value, "目標データ");
  const result = { ...value };
  for (const group of Object.keys(ENTITY_GROUPS)) {
    const rows = value[group] ?? [];
    if (!Array.isArray(rows)) throw new Error("目標データの" + group + "が正しくありません");
    for (const row of rows) {
      record(row, "目標データ");
      id(row.id, "保存済みID");
    }
    result[group] = rows.map((row) => ({ ...row }));
  }
  return result;
}

export function validateNode(input, nodes = [], items = []) {
  record(input, "目的・目標・手段");
  const node = {
    ...input,
    id: id(input.id, "ID"), kind: text(input.kind),
    parent_id: optionalId(input.parent_id, "親ID"), title: text(input.title).trim(),
    description: text(input.description), cover_item_id: optionalId(input.cover_item_id, "表紙ID"),
    sort_order: number(input.sort_order, 0, -1e9, 1e9, "並び順"),
    deleted: flag(input.deleted),
  };
  if (!["purpose", "goal", "means"].includes(node.kind)) throw new Error("種類が正しくありません");
  if (!node.title) throw new Error("名前を入力してください");
  if (node.title.length > 500 || node.description.length > 20000) throw new Error("文章が長すぎます");
  const byId = new Map(nodes.map((row) => [row.id, row]));
  const existing = byId.get(node.id);
  if (existing && existing.kind !== node.kind) throw new Error("保存した項目の種類は変更できません");
  const expectedParent = { goal: "purpose", means: "goal" }[node.kind];
  if (node.kind === "purpose") {
    if (node.parent_id) throw new Error("目的に親は設定できません");
  } else if (!isDeleted(node)) {
    const parent = byId.get(node.parent_id);
    if (!parent || isDeleted(parent) || parent.kind !== expectedParent) {
      throw new Error(node.kind === "goal" ? "関連する目的を選んでください" : "関連する目標を選んでください");
    }
  }
  const visited = new Set([node.id]);
  let parentId = node.parent_id;
  while (parentId) {
    if (visited.has(parentId)) throw new Error("親子関係が循環しています");
    visited.add(parentId);
    parentId = byId.get(parentId)?.parent_id || "";
  }
  const children = nodes.filter((row) => row.parent_id === node.id && !isDeleted(row));
  if (isDeleted(node) && children.length) throw new Error("先に関連する目標・手段を移動または削除してください");
  const expectedChild = { purpose: "goal", goal: "means" }[node.kind];
  if (children.some((child) => child.kind !== expectedChild)) throw new Error("子の項目と種類が一致しません");
  if (node.cover_item_id && !isDeleted(node)) {
    const cover = items.find((row) => row.id === node.cover_item_id && !isDeleted(row));
    if (node.kind !== "goal" || !cover || cover.goal_id !== node.id) {
      throw new Error("この目標に関連する画像を表紙に選んでください");
    }
  }
  return node;
}

export function normalizeBoard(input) {
  record(input, "ボード");
  const board = {
    ...input, id: id(input.id, "ボードID"), title: text(input.title).trim(),
    background: text(input.background || "cork"),
    width: number(input.width, 1200, 320, 20000, "ボードの幅"),
    height: number(input.height, 1600, 320, 20000, "ボードの高さ"),
    deleted: flag(input.deleted),
  };
  if (!board.title) throw new Error("ボード名を入力してください");
  if (board.title.length > 500) throw new Error("ボード名が長すぎます");
  if (board.background !== "cork") throw new Error("現在使える背景はコルクです");
  return board;
}

export function normalizeItem(input, nodes = [], boards = []) {
  record(input, "ボードの画像");
  const item = {
    ...input, id: id(input.id, "画像ID"), board_id: id(input.board_id, "ボードID"),
    attachment_id: id(input.attachment_id, "添付ID"), name: text(input.name),
    mime: text(input.mime || "image/jpeg"), caption: text(input.caption),
    goal_id: optionalId(input.goal_id, "目標ID"),
    x: number(input.x, 30, -20000, 20000, "横位置"),
    y: number(input.y, 30, -20000, 20000, "縦位置"),
    width: number(input.width, 280, 40, 4000, "画像の幅"),
    height: number(input.height, 220, 40, 4000, "画像の高さ"),
    rotation: number(input.rotation, 0, -180, 180, "画像の角度"),
    z_index: number(input.z_index, 0, -1e6, 1e6, "重なり順"),
    deleted: flag(input.deleted),
  };
  if (!/^image\//.test(item.mime)) throw new Error("画像ファイルを選んでください");
  if (item.name.length > 500 || item.mime.length > 100) throw new Error("ファイル名が長すぎます");
  if (item.caption.length > 20000) throw new Error("説明が長すぎます");
  if (!isDeleted(item)) {
    if (!boards.some((board) => board.id === item.board_id && !isDeleted(board))) throw new Error("先にボードを保存してください");
    if (item.goal_id && !nodes.some((node) => node.id === item.goal_id && node.kind === "goal" && !isDeleted(node))) {
      throw new Error("関連する目標を選んでください");
    }
  }
  return item;
}

// Remote omissions never mean deletion. Only explicit tombstones can hide an
// existing record, and neither pending nor later edits can be overwritten.
export function mergeGoalSnapshot(localInput, remoteInput, options = {}) {
  const local = goalSnapshot(localInput), remote = goalSnapshot(remoteInput);
  const pending = options.pending || new Set();
  const revisions = options.revisions || new Map();
  const currentRevision = options.currentRevision || (() => 0);
  const result = { ...local, ...remote };
  for (const [group, prefix] of Object.entries(ENTITY_GROUPS)) {
    const rows = new Map(local[group].map((row) => [row.id, row]));
    for (const incoming of remote[group]) {
      const key = prefix + incoming.id;
      if (pending.has(key) || (revisions.get(key) || 0) !== currentRevision(key)) continue;
      const existing = rows.get(incoming.id);
      if (existing && (incoming.updated_at || "") < (existing.updated_at || "")) continue;
      rows.set(incoming.id, { ...existing, ...incoming });
    }
    result[group] = [...rows.values()];
  }
  return result;
}
