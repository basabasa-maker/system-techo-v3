// system-techo-v3 GAS Web API
// Sprint 2: Task + Daily（calendar / memo_journal / memo_upsert）を実装
// 設計思想:
// - pullAll API は作らない（v1白紙化の教訓）
// - push系は1件upsertのみ
// - CALENDAR_IDS は basabasa-hq/システム手帳/config/calendar_ids.json を正として、
//   GAS内定数 CALENDAR_DEFS に同期する（初回コピペ、同期手段は別タスク）

const SPREADSHEET_ID = "1pENt1pTtF9A3CV-VY0VnP8VlbNM5mPZW9tSAtE8YKXs";
const SCHEMA_VERSION = 1;

/**
 * authorizeOnce
 * 全スコープを一括でトリガーし、OAuth承認画面を出すための関数。
 * バサバサがGASエディタから手動で1回実行し「許可」をクリックするだけ。
 * 以後のWeb App呼出は自動でこれらのスコープを使える。
 */
function authorizeOnce() {
  const results = {};
  try {
    results.spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID).getName();
  } catch (e) { results.spreadsheet = "ERR: " + e; }
  try {
    const cal = CalendarApp.getDefaultCalendar();
    results.calendar = cal ? cal.getName() : "no-default";
  } catch (e) { results.calendar = "ERR: " + e; }
  try {
    results.email = Session.getActiveUser().getEmail();
  } catch (e) { results.email = "ERR: " + e; }
  try {
    UrlFetchApp.fetch("https://www.google.com/robots.txt", { muteHttpExceptions: true });
    results.fetch = "ok";
  } catch (e) { results.fetch = "ERR: " + e; }
  Logger.log(JSON.stringify(results, null, 2));
  return results;
}

// ---- Sheets定義 ----

const TASKS_SHEET = "tasks";
const TASKS_HEADERS = [
  "id",
  "title",
  "status",
  "due_date",
  "priority",
  "tags",
  "source",
  "memo",
  "created_at",
  "updated_at",
  "deleted",
];

const MEMO_SHEET = "memo";
const MEMO_HEADERS = [
  "id",
  "entry_type",
  "date",
  "hour_slot",
  "title",
  "body",
  "tags",
  "created_at",
  "updated_at",
  "deleted",
];

// ---- カレンダー定義（basabasa-hq/システム手帳/config/calendar_ids.json 由来、9本） ----
// 出所: /Users/basabasa/basabasa-hq/システム手帳/config/calendar_ids.json (version:1)
// ラベルはjsonと完全一致させる。将来の同期手段は別タスクで検討。
const CALENDAR_DEFS = [
  { id: "basabasa@en-conect.com", label: "00_プライベートな予定" },
  { id: "c_df4f54fcca81acc58c9cca6bba17b979903c15abd54be8b13176122d0f0cd8a0@group.calendar.google.com", label: "00_実行" },
  { id: "c_8sv1q87i11lsbql5puu1bto420@group.calendar.google.com", label: "01_取材" },
  { id: "c_d238efeadb857d0cfab95a973626c2f1d3ca5116e2f85f6ccccc21d848694ca5@group.calendar.google.com", label: "03_取材予定（調整中）" },
  { id: "c_2376883f13ad1c7d785e4b0ec44bf04140ac4609e945563a4491c5bdd922f833@group.calendar.google.com", label: "04_定期的な予定" },
  { id: "c_4321769af6ef44c4b6014f5d2e464935fc985ad326ff5df54be6587de1869349@group.calendar.google.com", label: "05_定期的な予定（仕事）" },
  { id: "c_2dd3f3a724074ccfa2c8f674643f3158f3574d9f8d6545fa6a9d35f05e165ecf@group.calendar.google.com", label: "06_不定期な予定（仕事）" },
  { id: "c_nka1i3vmtoi026q1pg2mv56ps4@group.calendar.google.com", label: "07_バサ男とバサ子（未使用）" },
  { id: "ja.japanese#holiday@group.v.calendar.google.com", label: "日本の祝日" },
];

// ---------- Entry points ----------

function doGet(e) {
  const type = (e && e.parameter && e.parameter.type) || "";
  try {
    if (type === "meta") {
      return jsonResponse({
        ok: true,
        data: {
          schema_version: SCHEMA_VERSION,
          sprint: 2,
          now: nowJstString(),
          calendar_count: CALENDAR_DEFS.length,
        },
      });
    }
    if (type === "tasks") {
      const since = (e.parameter && e.parameter.since) || "";
      return jsonResponse({ ok: true, data: { tasks: pullTasks(since) } });
    }
    if (type === "calendar") {
      const date = (e.parameter && e.parameter.date) || "";
      return jsonResponse({ ok: true, data: { events: pullCalendarEvents(date) } });
    }
    if (type === "memo_journal") {
      const date = (e.parameter && e.parameter.date) || "";
      return jsonResponse({ ok: true, data: { entries: pullMemoJournal(date) } });
    }
    return jsonResponse({ ok: false, error: "Unknown type: " + type });
  } catch (err) {
    return jsonResponse({ ok: false, error: String((err && err.stack) || err) });
  }
}

function doPost(e) {
  try {
    let body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    const type = body.type || (e && e.parameter && e.parameter.type) || "";

    if (type === "task_upsert") {
      return jsonResponse({ ok: true, data: taskUpsert(body.task || {}) });
    }
    if (type === "task_delete") {
      return jsonResponse({ ok: true, data: taskDelete(body.id || "") });
    }
    if (type === "memo_upsert") {
      return jsonResponse({ ok: true, data: memoUpsert(body.entry || {}) });
    }
    if (type === "memo_delete") {
      return jsonResponse({ ok: true, data: memoDelete(body.id || "") });
    }
    return jsonResponse({ ok: false, error: "Unknown type: " + type });
  } catch (err) {
    return jsonResponse({ ok: false, error: String((err && err.stack) || err) });
  }
}

// ---------- Task operations ----------

function pullTasks(sinceStr) {
  const sheet = getSheet(TASKS_SHEET, TASKS_HEADERS);
  const rows = readAllRows(sheet, TASKS_HEADERS);
  const sinceDate = parseSinceParam(sinceStr);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.id) continue;
    const updated = parseJstDateTime(row.updated_at);
    if (sinceDate && updated && updated < sinceDate) continue;
    out.push(normalizeTaskOut(row));
  }
  return out;
}

function taskUpsert(task) {
  if (!task || !task.id) throw new Error("task.id required");
  const sheet = getSheet(TASKS_SHEET, TASKS_HEADERS);
  const now = nowJstString();
  const rowIdx = findRowIndexById(sheet, task.id);

  const base = rowIdx > 0 ? readRowAt(sheet, rowIdx, TASKS_HEADERS) : {};
  const merged = {
    id: task.id,
    title: task.title != null ? task.title : base.title || "",
    status: task.status || base.status || "todo",
    due_date: task.due_date != null ? task.due_date : base.due_date || "",
    priority: task.priority || base.priority || "mid",
    tags: task.tags != null ? task.tags : base.tags || "",
    source: task.source || base.source || "iphone",
    memo: task.memo != null ? task.memo : base.memo || "",
    created_at: base.created_at || task.created_at || now,
    updated_at: now,
    deleted: task.deleted ? 1 : 0,
  };

  const values = TASKS_HEADERS.map((h) => merged[h]);
  if (rowIdx > 0) {
    sheet.getRange(rowIdx, 1, 1, TASKS_HEADERS.length).setValues([values]);
  } else {
    sheet.appendRow(values);
  }
  return normalizeTaskOut(merged);
}

function taskDelete(id) {
  if (!id) throw new Error("id required");
  const sheet = getSheet(TASKS_SHEET, TASKS_HEADERS);
  const rowIdx = findRowIndexById(sheet, id);
  if (rowIdx <= 0) return { id: id, deleted: true, not_found: true };
  const now = nowJstString();
  const current = readRowAt(sheet, rowIdx, TASKS_HEADERS);
  current.deleted = 1;
  current.updated_at = now;
  const values = TASKS_HEADERS.map((h) => (current[h] != null ? current[h] : ""));
  sheet.getRange(rowIdx, 1, 1, TASKS_HEADERS.length).setValues([values]);
  return { id: id, deleted: true };
}

// ---------- Memo operations ----------

function pullMemoJournal(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ""))) {
    throw new Error("date required (YYYY-MM-DD)");
  }
  const sheet = getSheet(MEMO_SHEET, MEMO_HEADERS);
  const rows = readAllRows(sheet, MEMO_HEADERS);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.id) continue;
    if (isDeletedTruthy(row.deleted)) continue;
    if (String(row.entry_type || "") !== "journal") continue;
    // dateセルは '@' 書式のため文字列。Dateで返る可能性も吸収
    const dateVal = formatDateCell(row.date, "yyyy-MM-dd");
    if (dateVal !== dateStr) continue;
    out.push(normalizeMemoOut(row));
  }
  // hour_slot 昇順 → created_at 昇順
  out.sort((a, b) => {
    const ha = parseInt(a.hour_slot, 10);
    const hb = parseInt(b.hour_slot, 10);
    if (!isNaN(ha) && !isNaN(hb) && ha !== hb) return ha - hb;
    return (a.created_at || "") < (b.created_at || "") ? -1 : 1;
  });
  return out;
}

function memoUpsert(entry) {
  if (!entry) throw new Error("entry required");
  const entryType = String(entry.entry_type || "");
  if (entryType !== "journal") {
    // Sprint 2では journal のみ対応
    throw new Error("entry_type must be 'journal' in Sprint 2");
  }
  const sheet = getSheet(MEMO_SHEET, MEMO_HEADERS);
  const now = nowJstString();
  const id = entry.id || generateUuid();
  const rowIdx = findRowIndexById(sheet, id);
  const base = rowIdx > 0 ? readRowAt(sheet, rowIdx, MEMO_HEADERS) : {};

  const merged = {
    id: id,
    entry_type: entryType,
    date: entry.date != null ? String(entry.date) : String(base.date || ""),
    hour_slot: entry.hour_slot != null ? String(entry.hour_slot) : String(base.hour_slot || ""),
    title: entry.title != null ? entry.title : base.title || "",
    body: entry.body != null ? entry.body : base.body || "",
    tags: entry.tags != null ? entry.tags : base.tags || "",
    created_at: base.created_at
      ? formatDateCell(base.created_at, "yyyy-MM-dd HH:mm")
      : now,
    updated_at: now,
    deleted: entry.deleted ? 1 : 0,
  };

  const values = MEMO_HEADERS.map((h) => merged[h]);
  if (rowIdx > 0) {
    sheet.getRange(rowIdx, 1, 1, MEMO_HEADERS.length).setValues([values]);
  } else {
    sheet.appendRow(values);
  }
  return normalizeMemoOut(merged);
}

function memoDelete(id) {
  if (!id) throw new Error("id required");
  const sheet = getSheet(MEMO_SHEET, MEMO_HEADERS);
  const rowIdx = findRowIndexById(sheet, id);
  if (rowIdx <= 0) return { id: id, deleted: true, not_found: true };
  const now = nowJstString();
  const current = readRowAt(sheet, rowIdx, MEMO_HEADERS);
  current.deleted = 1;
  current.updated_at = now;
  const values = MEMO_HEADERS.map((h) => (current[h] != null ? current[h] : ""));
  sheet.getRange(rowIdx, 1, 1, MEMO_HEADERS.length).setValues([values]);
  return { id: id, deleted: true };
}

// ---------- Calendar operations ----------

function pullCalendarEvents(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ""))) {
    throw new Error("date required (YYYY-MM-DD)");
  }
  if (CALENDAR_DEFS.length < 9) {
    console.warn("CALENDAR_DEFS has fewer than 9 entries: " + CALENDAR_DEFS.length);
  }
  const target = parseYmdToJstDate(dateStr);
  const events = [];
  for (let i = 0; i < CALENDAR_DEFS.length; i++) {
    const def = CALENDAR_DEFS[i];
    try {
      const cal = CalendarApp.getCalendarById(def.id);
      if (!cal) {
        console.warn("Calendar not found: " + def.id);
        continue;
      }
      const rawEvents = cal.getEventsForDay(target);
      for (let j = 0; j < rawEvents.length; j++) {
        const ev = rawEvents[j];
        const allDay = ev.isAllDayEvent();
        let startStr, endStr;
        if (allDay) {
          startStr = Utilities.formatDate(ev.getAllDayStartDate(), "Asia/Tokyo", "yyyy-MM-dd");
          // getAllDayEndDate は翌日0:00 を返すので1日引きたいが、表示のため一貫性重視で生の値を返す
          endStr = Utilities.formatDate(ev.getAllDayEndDate(), "Asia/Tokyo", "yyyy-MM-dd");
        } else {
          startStr = Utilities.formatDate(ev.getStartTime(), "Asia/Tokyo", "yyyy-MM-dd HH:mm");
          endStr = Utilities.formatDate(ev.getEndTime(), "Asia/Tokyo", "yyyy-MM-dd HH:mm");
        }
        events.push({
          id: ev.getId(),
          calendar_id: def.id,
          calendar_label: def.label,
          start: startStr,
          end: endStr,
          all_day: allDay,
          summary: ev.getTitle() || "",
          location: ev.getLocation() || "",
        });
      }
    } catch (err) {
      console.warn("Calendar fetch failed: " + def.id + " - " + err);
    }
  }
  // 並び: 終日を先に、以降は開始時刻順
  events.sort((a, b) => {
    if (a.all_day && !b.all_day) return -1;
    if (!a.all_day && b.all_day) return 1;
    return (a.start || "") < (b.start || "") ? -1 : 1;
  });
  return events;
}

// ---------- Sheet helpers ----------

function enforceTextFormat(sheet, headers) {
  const maxRows = sheet.getMaxRows();
  sheet.getRange(1, 1, maxRows, headers.length).setNumberFormat("@");
}

function getSheet(name, headers) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    enforceTextFormat(sheet, headers);
    return sheet;
  }
  enforceTextFormat(sheet, headers);
  const firstRow = sheet
    .getRange(1, 1, 1, Math.max(headers.length, sheet.getLastColumn() || 1))
    .getValues()[0];
  let dirty = false;
  for (let i = 0; i < headers.length; i++) {
    if (firstRow[i] !== headers[i]) {
      dirty = true;
      break;
    }
  }
  if (dirty) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sheet;
}

function readAllRows(sheet, headers) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, headers.length).getValues();
  const out = [];
  for (let i = 0; i < values.length; i++) {
    out.push(rowToObject(values[i], headers));
  }
  return out;
}

function readRowAt(sheet, rowIdx, headers) {
  const values = sheet.getRange(rowIdx, 1, 1, headers.length).getValues()[0];
  return rowToObject(values, headers);
}

function rowToObject(values, headers) {
  const obj = {};
  for (let i = 0; i < headers.length; i++) {
    obj[headers[i]] = values[i];
  }
  return obj;
}

function findRowIndexById(sheet, id) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return i + 2;
  }
  return 0;
}

function normalizeTaskOut(row) {
  return {
    id: String(row.id || ""),
    title: String(row.title || ""),
    status: String(row.status || "todo"),
    due_date: formatDateCell(row.due_date, "yyyy-MM-dd"),
    priority: String(row.priority || "mid"),
    tags: row.tags ? String(row.tags) : "",
    source: row.source ? String(row.source) : "",
    memo: row.memo ? String(row.memo) : "",
    created_at: formatDateCell(row.created_at, "yyyy-MM-dd HH:mm"),
    updated_at: formatDateCell(row.updated_at, "yyyy-MM-dd HH:mm"),
    deleted: isDeletedTruthy(row.deleted) ? 1 : 0,
  };
}

function normalizeMemoOut(row) {
  return {
    id: String(row.id || ""),
    entry_type: String(row.entry_type || ""),
    date: formatDateCell(row.date, "yyyy-MM-dd"),
    hour_slot: row.hour_slot != null ? String(row.hour_slot) : "",
    title: row.title ? String(row.title) : "",
    body: row.body ? String(row.body) : "",
    tags: row.tags ? String(row.tags) : "",
    created_at: formatDateCell(row.created_at, "yyyy-MM-dd HH:mm"),
    updated_at: formatDateCell(row.updated_at, "yyyy-MM-dd HH:mm"),
    deleted: isDeletedTruthy(row.deleted) ? 1 : 0,
  };
}

// 文字列書式('@')セルは "0" を返すが、JSでは truthy のため明示的に判定する
function isDeletedTruthy(v) {
  if (v === 1 || v === true) return true;
  if (v === 0 || v === false || v == null || v === "") return false;
  const s = String(v).trim();
  return s === "1" || s.toLowerCase() === "true";
}

function formatDateCell(v, pattern) {
  if (v == null || v === "") return "";
  if (v instanceof Date) {
    return Utilities.formatDate(v, "Asia/Tokyo", pattern);
  }
  return String(v);
}

function generateUuid() {
  return Utilities.getUuid();
}

// ---------- Date helpers (JST, toISOString禁止) ----------

function nowJstString() {
  return Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd HH:mm");
}

function parseSinceParam(s) {
  if (!s) {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(
    parseInt(m[1], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[3], 10),
    0, 0, 0, 0,
  );
}

function parseYmdToJstDate(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error("invalid date: " + s);
  // JST 12:00 固定で作成（タイムゾーン境界の安全側）
  return new Date(
    parseInt(m[1], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[3], 10),
    12, 0, 0, 0,
  );
}

function parseJstDateTime(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  const str = String(s);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(
    parseInt(m[1], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[3], 10),
    parseInt(m[4], 10),
    parseInt(m[5], 10),
    0, 0,
  );
}

// ---------- Response ----------

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
