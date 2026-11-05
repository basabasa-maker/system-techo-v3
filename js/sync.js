// sync.js - 未送信キュー（outbox）の共通の送信処理
// - 同じ対象（同じタスク・同じ日など）の古い送信待ちは捨て、最新の1件だけ送る
//   （古い失敗分が、後から成功した新しい編集を上書きして戻すのを防ぐ）
// - 1件の失敗で、ほかの送信を止めない（失敗分だけ残して次へ進む）
// - 送信待ちの対象を調べ、取得結果が未送信の変更を消さないようにする

import * as gas from "./gas-client.js";
import * as outbox from "./outbox.js";

// 送信待ちの対象を表すキー
function keyOf(op) {
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
    default:
      return null;
  }
}

async function send(op) {
  const p = op.payload || {};
  switch (op.type) {
    case "task_upsert":
      return gas.pushTaskUpsert(p);
    case "task_delete":
      return gas.pushTaskDelete(p.id);
    case "memo_upsert":
      return gas.pushMemoUpsert(p);
    case "memo_delete":
      return gas.pushMemoDelete(p.id);
    case "habit_day_upsert":
      return gas.pushHabitDay(p.date, p.values);
    case "habit_items_upsert":
      return gas.pushHabitItems(p.items);
    case "meal_day_upsert":
      return gas.pushMealDay(p.date, p.slots);
    default:
      return null;
  }
}

let running = null;

// すべての送信待ちを送る。送れなかった件数を返す
export function flushAll() {
  if (running) return running;
  running = (async () => {
    const items = (await outbox.listAll()).sort((a, b) => a.id - b.id);
    // 同じ対象は、いちばん新しい1件だけ残す
    const latest = new Map();
    for (const it of items) {
      const k = keyOf(it.op);
      if (k) latest.set(k, it.id);
    }
    let failed = 0;
    for (const it of items) {
      const k = keyOf(it.op);
      if (!k) continue; // 知らない種類は触らない
      if (latest.get(k) !== it.id) {
        await outbox.remove(it.id); // 古い分は不要
        continue;
      }
      try {
        await send(it.op);
        await outbox.remove(it.id);
      } catch (e) {
        failed++;
      }
    }
    return failed;
  })().finally(() => {
    running = null;
  });
  return running;
}

// いま送信待ちの対象キーの集まり
export async function pendingKeys() {
  const items = await outbox.listAll();
  const set = new Set();
  for (const it of items) {
    const k = keyOf(it.op);
    if (k) set.add(k);
  }
  return set;
}

// 更新の完了メッセージに添える、未送信の件数の言い方
export async function pendingNote() {
  const n = (await pendingKeys()).size;
  return n > 0 ? `（未送信${n}件）` : "";
}
