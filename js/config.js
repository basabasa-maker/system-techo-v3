// config.js - 環境設定
// GAS Web App URL (Sprint 0 で発行済、Sprint 2 で calendar/memo API 追加)
export const GAS_URL =
  "https://script.google.com/macros/s/AKfycbwSm0NCuVXkLU0CErNYn8EXR8spop6D5Fycv7JiFAAL2vipQ3PB_yBUEzw0a-zPTDDw/exec";

export const LS_KEY_TASKS = "sth_v3_tasks_cache";
export const LS_KEY_ACTIVE_TAB = "sth_v3_active_tab";
export const LS_KEY_CACHE_SCHEMA = "sth_v3_cache_schema";
export const LS_KEY_CAL_PREFIX = "sth_v3_cal_"; // + YYYY-MM-DD
export const LS_KEY_JOURNAL_PREFIX = "sth_v3_journal_"; // + YYYY-MM-DD
export const LS_KEY_MEMO_DAY_PREFIX = "sth_v3_memoday_"; // + YYYY-MM-DD
export const LS_KEY_MEMO_NOTES = "sth_v3_memo_notes";
export const LS_KEY_MEMO_ALL = "sth_v3_memo_all";
export const LS_KEY_HABIT_DAY_PREFIX = "sth_v3_habitday_"; // + YYYY-MM-DD
export const LS_KEY_HABIT_ITEMS = "sth_v3_habit_items";
export const LS_KEY_MEAL_DAY_PREFIX = "sth_v3_mealday_"; // + YYYY-MM-DD
export const CACHE_SCHEMA_VERSION = 4;

// 習慣タブの初期項目（旧アプリ「習慣ログ」の2026-11-04時点の並びを引き継ぐ）
// type: time=時刻 / number=数値 / check=チェック
export const HABIT_DEFAULT_ITEMS = [
  { id: "sleepStart", label: "就寝時刻", icon: "🌙", type: "time", unit: "" },
  { id: "sleepEnd", label: "起床時刻", icon: "☀️", type: "time", unit: "" },
  { id: "nap", label: "パワーナップ", icon: "💤", type: "number", unit: "分" },
  { id: "weight", label: "体重", icon: "⚖️", type: "number", unit: "kg" },
  { id: "bodyFat", label: "体脂肪率", icon: "📏", type: "number", unit: "%" },
  { id: "kcal", label: "消費カロリー", icon: "🔥", type: "number", unit: "kcal" },
  { id: "steps", label: "歩数", icon: "👣", type: "number", unit: "歩" },
  { id: "lastMeal", label: "前日の最終食事", icon: "🍽️", type: "time", unit: "" },
  { id: "water", label: "水分（無糖）", icon: "💧", type: "number", unit: "ml" },
  { id: "fast16", label: "食間16時間", icon: "📈", type: "check", unit: "" },
  { id: "meditation", label: "瞑想", icon: "🧘", type: "check", unit: "" },
  { id: "taskCheck", label: "タスクチェック", icon: "📋", type: "check", unit: "" },
  { id: "emailCheck", label: "メールチェック", icon: "📧", type: "check", unit: "" },
  { id: "calendarCheck", label: "カレンダーチェック", icon: "📅", type: "check", unit: "" },
  { id: "read5", label: "5分以上読書する", icon: "📖", type: "check", unit: "" },
  { id: "cs50", label: "CS50学習（10分以上）", icon: "📱", type: "check", unit: "" },
  { id: "stretch", label: "朝のストレッチ", icon: "🤸", type: "check", unit: "" },
  { id: "housework", label: "家事", icon: "🏠", type: "check", unit: "" },
  { id: "suppAm", label: "朝サプリ飲んだ", icon: "🕐", type: "check", unit: "" },
  { id: "suppNoon", label: "昼サプリ飲んだ", icon: "🕐", type: "check", unit: "" },
  { id: "suppPm", label: "夜サプリ飲んだ", icon: "🕐", type: "check", unit: "" },
  { id: "finasteride", label: "フィン服用", icon: "💊", type: "check", unit: "" },
  { id: "suppPrep", label: "明日のサプリの準備", icon: "💪", type: "check", unit: "" },
  { id: "walk8000", label: "8000歩以上歩いた", icon: "🔥", type: "check", unit: "" },
  { id: "tabelogFollowers", label: "食べログ フォロワー", icon: "⭐", type: "cumulative", unit: "人" },
  { id: "tabelogReactions", label: "食べログ リアクション", icon: "📊", type: "cumulative", unit: "件" },
  { id: "instaFollowers", label: "Instagram フォロワー", icon: "📸", type: "cumulative", unit: "人" },
];

// 食事タブの区分と時刻プルダウンの刻み（分）
export const MEAL_SLOTS = ["朝", "昼", "夕", "間食", "夜食"];
export const MEAL_TIME_STEP_MIN = 15;

// Memoタブ種別の色・アイコン
export const MEMO_TYPE_DEFS = {
  journal: { label: "ジャーナル", color: "#4d90fe", mark: "J" },
  note: { label: "ノート", color: "#4ea572", mark: "N" },
  read_later: { label: "あとで読む", color: "#e08a3a", mark: "R" },
};

// カレンダー定義（basabasa-hq/システム手帳/config/calendar_ids.json と同期、9本）
// GAS側 CALENDAR_DEFS と必ず同じ順序・ラベルにする
export const CALENDAR_DEFS = [
  {
    id: "basabasa@en-conect.com",
    label: "00_プライベートな予定",
    color: "#4d90fe",
  },
  {
    id: "c_df4f54fcca81acc58c9cca6bba17b979903c15abd54be8b13176122d0f0cd8a0@group.calendar.google.com",
    label: "00_実行",
    color: "#d95252",
  },
  {
    id: "c_8sv1q87i11lsbql5puu1bto420@group.calendar.google.com",
    label: "01_取材",
    color: "#4ea572",
  },
  {
    id: "c_d238efeadb857d0cfab95a973626c2f1d3ca5116e2f85f6ccccc21d848694ca5@group.calendar.google.com",
    label: "03_取材予定（調整中）",
    color: "#e08a3a",
  },
  {
    id: "c_2376883f13ad1c7d785e4b0ec44bf04140ac4609e945563a4491c5bdd922f833@group.calendar.google.com",
    label: "04_定期的な予定",
    color: "#9a6ed8",
  },
  {
    id: "c_4321769af6ef44c4b6014f5d2e464935fc985ad326ff5df54be6587de1869349@group.calendar.google.com",
    label: "05_定期的な予定（仕事）",
    color: "#3aa7a4",
  },
  {
    id: "c_2dd3f3a724074ccfa2c8f674643f3158f3574d9f8d6545fa6a9d35f05e165ecf@group.calendar.google.com",
    label: "06_不定期な予定（仕事）",
    color: "#d86aa3",
  },
  {
    id: "c_nka1i3vmtoi026q1pg2mv56ps4@group.calendar.google.com",
    label: "07_バサ男とバサ子（未使用）",
    color: "#c9b44a",
  },
  {
    id: "ja.japanese#holiday@group.v.calendar.google.com",
    label: "日本の祝日",
    color: "#7a8599",
  },
];

export function calendarColorFor(calendarId) {
  const def = CALENDAR_DEFS.find((d) => d.id === calendarId);
  return def ? def.color : "#566b89";
}
