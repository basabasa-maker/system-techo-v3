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
export const CACHE_SCHEMA_VERSION = 4;

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
