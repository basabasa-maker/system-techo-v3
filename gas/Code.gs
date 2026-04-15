// system-techo-v3 GAS Web API
// Sprint 1: Task タブ向け tasks / task_upsert / task_delete を実装
// 設計思想:
// - pullAll API は作らない（v1白紙化の教訓）
// - push系は1件upsertのみ
// - CALENDAR_IDS は basabasa-hq/システム手帳/config/calendar_ids.json を参照（Sprint 2で連携）

const SPREADSHEET_ID = "1pENt1pTtF9A3CV-VY0VnP8VlbNM5mPZW9tSAtE8YKXs";
const SCHEMA_VERSION = 1;

// tasks シートのヘッダー（Sprint 0 で定義済みと合わせる）
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

// ---------- Entry points ----------

function doGet(e) {
  const type = (e && e.parameter && e.parameter.type) || "";
  try {
    if (type === "meta") {
      return jsonResponse({
        ok: true,
        data: {
          schema_version: SCHEMA_VERSION,
          sprint: 1,
          now: nowJstString(),
        },
      });
    }
    if (type === "tasks") {
      const since = (e.parameter && e.parameter.since) || "";
      return jsonResponse({
        ok: true,
        data: { tasks: pullTasks(since) },
      });
    }
    return jsonResponse({
      ok: false,
      error: "Unknown type: " + type,
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err && err.stack || err) });
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
    return jsonResponse({ ok: false, error: "Unknown type: " + type });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err && err.stack || err) });
  }
}

// ---------- Task operations ----------

function pullTasks(sinceStr) {
  const sheet = getSheet(TASKS_SHEET);
  const rows = readAllRows(sheet);
  const sinceDate = parseSinceParam(sinceStr);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.id) continue;
    const updated = parseJstDateTime(row.updated_at);
    if (sinceDate && updated && updated < sinceDate) continue;
    // deleted行も含めて返す（端末側が論理削除を反映できるように）
    out.push(normalizeTaskOut(row));
  }
  return out;
}

function taskUpsert(task) {
  if (!task || !task.id) throw new Error("task.id required");
  const sheet = getSheet(TASKS_SHEET);
  const now = nowJstString();
  const rowIdx = findRowIndexById(sheet, task.id);

  const base = rowIdx > 0 ? readRowAt(sheet, rowIdx) : {};
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
  const sheet = getSheet(TASKS_SHEET);
  const rowIdx = findRowIndexById(sheet, id);
  if (rowIdx <= 0) return { id: id, deleted: true, not_found: true };
  const now = nowJstString();
  const current = readRowAt(sheet, rowIdx);
  current.deleted = 1;
  current.updated_at = now;
  const values = TASKS_HEADERS.map((h) => current[h] != null ? current[h] : "");
  sheet.getRange(rowIdx, 1, 1, TASKS_HEADERS.length).setValues([values]);
  return { id: id, deleted: true };
}

function enforceTextFormat(sheet) {
  // 日時列を文字列書式(@)に強制。Sheetsの自動Date解釈による9時間ズレを防ぐ
  const maxRows = sheet.getMaxRows();
  sheet.getRange(1, 1, maxRows, TASKS_HEADERS.length).setNumberFormat("@");
}

// ---------- Sheet helpers ----------

function getSheet(name) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, TASKS_HEADERS.length).setValues([TASKS_HEADERS]);
    enforceTextFormat(sheet);
    return sheet;
  }
  enforceTextFormat(sheet);
  // ヘッダー欠損時の補修（memo列追加など後方互換）
  const firstRow = sheet
    .getRange(1, 1, 1, Math.max(TASKS_HEADERS.length, sheet.getLastColumn() || 1))
    .getValues()[0];
  let dirty = false;
  for (let i = 0; i < TASKS_HEADERS.length; i++) {
    if (firstRow[i] !== TASKS_HEADERS[i]) {
      dirty = true;
      break;
    }
  }
  if (dirty) {
    sheet.getRange(1, 1, 1, TASKS_HEADERS.length).setValues([TASKS_HEADERS]);
  }
  return sheet;
}

function readAllRows(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet
    .getRange(2, 1, last - 1, TASKS_HEADERS.length)
    .getValues();
  const out = [];
  for (let i = 0; i < values.length; i++) {
    out.push(rowToObject(values[i]));
  }
  return out;
}

function readRowAt(sheet, rowIdx) {
  const values = sheet
    .getRange(rowIdx, 1, 1, TASKS_HEADERS.length)
    .getValues()[0];
  return rowToObject(values);
}

function rowToObject(values) {
  const obj = {};
  for (let i = 0; i < TASKS_HEADERS.length; i++) {
    obj[TASKS_HEADERS[i]] = values[i];
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

// ---------- Date helpers (JST, toISOString禁止) ----------

function nowJstString() {
  const d = new Date();
  return formatJst(d);
}

function formatJst(d) {
  const tz = "Asia/Tokyo";
  return Utilities.formatDate(d, tz, "yyyy-MM-dd HH:mm");
}

function parseSinceParam(s) {
  if (!s) {
    // 未指定時は過去30日
    const d = new Date();
    d.setDate(d.getDate() - 30);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  // YYYY-MM-DD
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(
    parseInt(m[1], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[3], 10),
    0,
    0,
    0,
    0,
  );
  return d;
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
    0,
    0,
  );
}

// ---------- Response ----------

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
