// 食事記録から有効な時刻だけを比較する。元の記録は変更しない。
import { MEAL_SLOTS } from "./config.js";

export function latestMealTime(slots) {
  let latest = null;
  for (const slot of MEAL_SLOTS) {
    const value = slots?.[slot]?.time;
    const match = typeof value === "string" && /^(\d{1,2}):(\d{2})$/.exec(value);
    if (!match) continue;
    const hour = Number(match[1]), minute = Number(match[2]);
    if (hour > 23 || minute > 59) continue;
    const time = hour * 60 + minute;
    if (latest === null || time > latest) latest = time;
  }
  return latest === null ? null : `${String(Math.floor(latest / 60)).padStart(2, "0")}:${String(latest % 60).padStart(2, "0")}`;
}
