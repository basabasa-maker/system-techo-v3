// tabs.js - タブの入口を登録する。入力中・取得中の状態は各機能が管理する。
import { renderTaskTab, pullAndRender as pullTask } from "./task.js";
import { renderDailyTab, pullAndRender as pullDaily } from "./daily.js";
import { renderMemoTab, pullAndRender as pullMemo } from "./memo.js";
import { renderHabitTab, pullAndRender as pullHabit } from "./habit.js";
import { renderMealTab, pullAndRender as pullMeal } from "./meal.js";
import { daysAgoYmd } from "./date-util.js";
import { renderGoalsTab, pullAndRender as pullGoals, disposeGoalsTab } from "./goals.js";

export const DEFAULT_TAB = "task";

// 上のボタンの表示順は index.html で決める。
// 習慣・食事・メモは render 内で取得するため、quietSync を重ねて呼ばない。
export const TAB_DEFINITIONS = Object.freeze({
  daily: {
    render: renderDailyTab,
    refresh: () => pullDaily(),
    quietSync: () => pullDaily(true),
  },
  task: {
    render: renderTaskTab,
    refresh: () => pullTask(daysAgoYmd(30)),
    quietSync: () => pullTask(daysAgoYmd(30), true),
  },
  habit: { render: renderHabitTab, refresh: () => pullHabit() },
  meal: { render: renderMealTab, refresh: () => pullMeal() },
  memo: { render: renderMemoTab, refresh: () => pullMemo() },
  goals: { render: renderGoalsTab, refresh: () => pullGoals(), dispose: disposeGoalsTab },
});
