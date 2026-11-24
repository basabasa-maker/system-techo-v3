// 同期の操作規則。ストレージ・通信・DOMに依存しない。

// 送信待ちの対象を表すキー
export function keyOf(op) {
  const p = op.payload || {};
  switch (op.type) {
    case "task_upsert":
      return "task:" + p.id;
    case "task_delete":
      return "task:" + p.id;
    case "memo_upsert":
      return "memo:" + p.id;
    case "memo_delete":
      return "memo:" + p.id;
    case "habit_day_upsert":
      return "habit_day:" + p.date;
    case "habit_items_upsert":
      return "habit_items";
    case "meal_day_upsert":
      return "meal:" + p.date;
    case "goal_node_upsert":
      return "goal_node:" + p.id;
    case "goal_board_upsert":
      return "goal_board:" + p.id;
    case "goal_item_upsert":
      return "goal_item:" + p.id;
    default:
      return null;
  }
}

// Goal records can depend on earlier records (goal -> image -> cover).
// They must retain queue order rather than collapse into one latest operation.
export function isGoalOperation(op) {
  return ["goal_node_upsert", "goal_board_upsert", "goal_item_upsert"].includes(op.type);
}

// 習慣の「変えた項目」の形にそろえる（旧形式の values は追加・更新のみ扱い）
export function toPatch(p) {
  return { set: p.set || p.values || {}, del: p.del || [] };
}

// 食事の「変えた区分」の形にそろえる（旧形式の slots も、入っている区分を追加・更新として扱う）
export function mealSet(p) {
  return p.set || p.slots || {};
}

// 2つの変更を1つにまとめる（あとの変更が勝つ）
export function mergePatch(a, b) {
  const set = { ...a.set };
  let del = new Set(a.del);
  for (const k of b.del) {
    delete set[k];
    del.add(k);
  }
  for (const k of Object.keys(b.set)) {
    set[k] = b.set[k];
    del.delete(k);
  }
  return { set, del: [...del] };
}

// ID順に並んだ同じ対象の操作を合成する。元の操作・キューIDは変更しない。
export function coalesceOperations(list) {
  let op = list[list.length - 1].op;
  if (op.type === "meal_day_upsert") {
    let set = {};
    for (const it of list) set = { ...set, ...mealSet(it.op.payload || {}) };
    op = { type: op.type, payload: { date: op.payload.date, set } };
  } else if (op.type === "habit_day_upsert") {
    let merged = { set: {}, del: [] };
    for (const it of list) merged = mergePatch(merged, toPatch(it.op.payload || {}));
    op = { type: op.type, payload: { date: op.payload.date, set: merged.set, del: merged.del } };
  }
  return op;
}
