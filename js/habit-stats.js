// habit-stats.js - 習慣のグラフ（30日）と履歴。旧アプリ「習慣ログ」から移した機能
// 30日分は、まずサーバーからまとめて取り、取れなければ手元の控えで描く

import * as gas from "./gas-client.js";
import { LS_KEY_HABIT_DAY_PREFIX } from "./config.js";
import { todayYmd, addDaysYmd, parseYmd } from "./date-util.js";

// 表示する期間（日数）。グラフ・履歴の上の切り替えで変える
export const RANGES = [
  { days: 30, label: "30日" },
  { days: 90, label: "90日" },
  { days: 180, label: "半年" },
  { days: 400, label: "全期間" },
];
let rangeDays = 30;
export function getRangeDays() {
  return rangeDays;
}
export function setRangeDays(n) {
  rangeDays = n;
}

export function lastDays() {
  const t = todayYmd();
  const out = [];
  for (let i = rangeDays - 1; i >= 0; i--) out.push(addDaysYmd(t, -i));
  return out;
}

function localDay(ymd) {
  try {
    const raw = localStorage.getItem(LS_KEY_HABIT_DAY_PREFIX + ymd);
    const o = raw ? JSON.parse(raw) : null;
    return o && typeof o === "object" ? o : null;
  } catch (e) {
    return null;
  }
}

// 30日分（日付→記録）。サーバー分を手元の控えにも書く
export async function loadRange() {
  const days = lastDays();
  let remote = {};
  try {
    remote = await gas.pullHabitRange(days[0], days[days.length - 1]);
    for (const [d, v] of Object.entries(remote)) {
      localStorage.setItem(LS_KEY_HABIT_DAY_PREFIX + d, JSON.stringify(v));
    }
  } catch (e) {
    console.warn("habit range skipped:", e.message);
  }
  const out = {};
  for (const d of days) {
    const v = remote[d] || localDay(d);
    if (v) out[d] = v;
  }
  return out;
}

function toMin(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

export function sleepHours(v) {
  if (!v) return null;
  const a = toMin(v.sleepStart);
  const b = toMin(v.sleepEnd);
  if (a == null || b == null) return null;
  let d = b - a;
  if (d <= 0) d += 1440;
  return d / 60;
}

function checkRate(v, items) {
  if (!v) return null;
  const checks = items.filter((i) => i.type === "check");
  if (checks.length === 0) return null;
  const done = checks.filter((i) => v[i.id] === true).length;
  return (done / checks.length) * 100;
}

function num(v, id) {
  const n = v && v[id];
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function drawChart(canvas, statsEl, days, vals, unit, color, digits) {
  const w = (canvas.width = canvas.parentElement.clientWidth);
  const h = (canvas.height = 160);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  const muted = cssVar("--muted", "#999");
  const fv = vals.filter((v) => v !== null);
  if (fv.length === 0) {
    ctx.fillStyle = muted;
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("データがありません", w / 2, h / 2);
    statsEl.innerHTML = "";
    return;
  }
  const P = { t: 18, r: 12, b: 24, l: 46 };
  const cw = w - P.l - P.r;
  const ch = h - P.t - P.b;
  let mn = Math.min(...fv);
  let mx = Math.max(...fv);
  const pad = (mx - mn) * 0.1 || Math.abs(mx) * 0.05 || 1;
  mn -= pad;
  mx += pad;
  const rng = mx - mn;
  ctx.strokeStyle = `rgb(${cssVar("--ov", "255 255 255").replace(/ /g, ",")})`;
  ctx.globalAlpha = 0.15;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = P.t + ch - (ch * i) / 4;
    ctx.beginPath();
    ctx.moveTo(P.l, y);
    ctx.lineTo(w - P.r, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = muted;
  ctx.font = "10px sans-serif";
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const y = P.t + ch - (ch * i) / 4;
    ctx.fillText((mn + (rng * i) / 4).toFixed(digits), P.l - 4, y + 3);
  }
  // 日付の目盛り（5日おき）
  ctx.textAlign = "center";
  const step = days.length <= 35 ? 7 : days.length <= 100 ? 14 : days.length <= 200 ? 30 : 60;
  days.forEach((d, i) => {
    if (i % step !== 0 && !(i === days.length - 1 && i % step >= step * 0.85)) return;
    const x = P.l + (cw * i) / (days.length - 1);
    ctx.fillText(days.length > 200 ? d.slice(2, 7).replace("-", "/") : d.slice(5).replace("-", "/"), x, h - 8);
  });
  const xy = (i, v) => [P.l + (cw * i) / (days.length - 1), P.t + ch - ((v - mn) / rng) * ch];
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  let started = false;
  vals.forEach((v, i) => {
    if (v === null) return;
    const [x, y] = xy(i, v);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = color;
  vals.forEach((v, i) => {
    if (v === null) return;
    const [x, y] = xy(i, v);
    ctx.beginPath();
    ctx.arc(x, y, days.length > 60 ? 1.6 : 3, 0, Math.PI * 2);
    ctx.fill();
  });
  const avg = fv.reduce((a, b) => a + b, 0) / fv.length;
  const f = (n) => n.toFixed(digits) + unit;
  statsEl.innerHTML = `<div>平均:<span>${f(avg)}</span></div><div>最高:<span>${f(Math.max(...fv))}</span></div><div>最低:<span>${f(Math.min(...fv))}</span></div><div>記録:<span>${fv.length}日</span></div>`;
}

function rangeLabel() {
  const r = RANGES.find((x) => x.days === rangeDays);
  return r ? r.label : rangeDays + "日";
}

const CHARTS = [
  { title: "体重", unit: "kg", color: "#2ec4a0", digits: 1, get: (v) => num(v, "weight") },
  { title: "睡眠時間", unit: "h", color: "#af52de", digits: 1, get: (v, it) => sleepHours(v) },
  { title: "歩数", unit: "歩", color: "#34c759", digits: 0, get: (v) => num(v, "steps") },
  { title: "ルーチン達成率", unit: "%", color: "#ff9500", digits: 0, get: (v, it) => checkRate(v, it) },
  { title: "水分摂取量", unit: "ml", color: "#4d9cff", digits: 0, get: (v) => num(v, "water") },
];

export function renderCharts(box, items, data) {
  let days = lastDays();
  // 長い期間では、記録のない最初の部分を省く
  if (rangeDays > 30) {
    const first = days.findIndex((d) => data[d]);
    if (first > 0) days = days.slice(first);
  }
  box.innerHTML = CHARTS.map(
    (c, i) => `<div class="chart-c"><div class="chart-t">${c.title}（${rangeLabel()}）</div><canvas id="hc${i}"></canvas><div class="chart-s" id="hs${i}"></div></div>`,
  ).join("");
  requestAnimationFrame(() => {
    CHARTS.forEach((c, i) => {
      const vals = days.map((d) => {
        const v = data[d];
        if (!v) return null;
        return c.title === "ルーチン達成率" ? checkRate(v, items) : c.get(v, items);
      });
      const cv = box.querySelector("#hc" + i);
      if (cv) drawChart(cv, box.querySelector("#hs" + i), days, vals, c.unit, c.color, c.digits);
    });
  });
}

export function renderHistory(box, items, data, onPick) {
  const dates = Object.keys(data).sort().reverse();
  if (dates.length === 0) {
    box.innerHTML = `<p class="empty-hint">記録がありません。</p>`;
    return;
  }
  const checks = items.filter((i) => i.type === "check");
  box.innerHTML = dates
    .map((d) => {
      const v = data[d];
      const dt = parseYmd(d);
      const w = ["日", "月", "火", "水", "木", "金", "土"][dt.getDay()];
      const parts = [];
      const sl = sleepHours(v);
      if (sl != null) parts.push(`睡眠${sl.toFixed(1)}h`);
      if (num(v, "weight") != null) parts.push(`${v.weight}kg`);
      if (num(v, "steps") != null) parts.push(`${v.steps.toLocaleString()}歩`);
      if (num(v, "water") != null) parts.push(`水${v.water}ml`);
      if (checks.length) parts.push(`達成${checks.filter((i) => v[i.id] === true).length}/${checks.length}`);
      return `<button class="hist-row" data-date="${d}"><span class="hist-d">${dt.getMonth() + 1}/${dt.getDate()}（${w}）</span><span class="hist-v">${parts.join(" ・ ")}</span></button>`;
    })
    .join("");
  box.querySelectorAll(".hist-row").forEach((b) => b.addEventListener("click", () => onPick(b.dataset.date)));
}
