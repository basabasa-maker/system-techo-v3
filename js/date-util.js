// date-util.js
// JST基準の日付ユーティリティ。toISOString は使用しない。

export function pad2(n) {
  return String(n).padStart(2, "0");
}

export function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function nowJst() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Date -> "YYYY-MM-DD"
export function toYmd(d) {
  if (!d) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 文字列 "YYYY-MM-DD" -> Date（ローカル 0:00）。不正なら null
export function parseYmd(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(
    parseInt(m[1], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[3], 10),
  );
}

export function daysAgoYmd(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return toYmd(d);
}

// 表示用：期限→残日数
export function dueLabel(ymd) {
  const d = parseYmd(ymd);
  if (!d) return "";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return "今日";
  if (diff === 1) return "明日";
  if (diff === -1) return "昨日";
  if (diff < 0) return `${-diff}日前`;
  return `${diff}日後`;
}
