// system-techo-v3 GAS Web API
// Sprint 3: Memoタブ（memo_notes / memo_search / memo_url_fetch / memo_inbox_write）を追加
// Sprint 4: iOSショートカット共有シート連携（share_add）を追加
// 設計思想:
// - pullAll API は作らない（v1白紙化の教訓）
// - push系は1件upsertのみ
// - CALENDAR_IDS は basabasa-hq/システム手帳/config/calendar_ids.json を正として、
//   GAS内定数 CALENDAR_DEFS に同期する（初回コピペ、同期手段は別タスク）

const SPREADSHEET_ID = "1pENt1pTtF9A3CV-VY0VnP8VlbNM5mPZW9tSAtE8YKXs";
const SCHEMA_VERSION = 2;

// Claude取込用Driveフォルダ（未設定の場合はファイル書き出しをスキップし、claude_takenフラグのみ更新）
// バサバサが後日 Drive フォルダID を設定する。設定済なら memo_inbox_write で Markdown を書き出す。
const INBOX_FOLDER_ID = "";

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

/** Owner authorization check, callable from the editor; no REST route or data copies. */
function authorizeBackupSetup() {
  ScriptApp.requireScopes(ScriptApp.AuthMode.FULL, [
    "https://www.googleapis.com/auth/script.scriptapp",
  ]);
  backupOwner_();
  ScriptApp.getProjectTriggers();
  return { authorized: true };
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
  "pinned",
  "sort_order",
];

// 習慣・食事は「日付1行」のJSON保存。全件上書きはしない（日付単位のupsertのみ）
const HABIT_DAYS_SHEET = "habit_days";
const HABIT_DAYS_HEADERS = ["date", "json", "updated_at"];
const HABIT_ITEMS_SHEET = "habit_items";
const HABIT_ITEMS_HEADERS = ["id", "json", "updated_at"];
const MEAL_SHEET = "meals";
const MEAL_HEADERS = ["date", "json", "updated_at"];

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
  "claude_taken",
  "pinned",
  "sort_order",
  "archived",
];

const MEMO_ALLOWED_TYPES = ["journal", "note", "read_later"];

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
    if (type === "backup_status") {
      return jsonResponse({ ok: true, data: getBackupStatus() });
    }
    if (type === "backup_admin") {
      return renderBackupAdminPage();
    }
    if (type === "goals") {
      return jsonResponse({ ok: true, data: pullGoals() });
    }
    if (type === "meta") {
      return jsonResponse({
        ok: true,
        data: {
          schema_version: SCHEMA_VERSION,
          sprint: 4,
          now: nowJstString(),
          calendar_count: CALENDAR_DEFS.length,
        },
      });
    }
    if (type === "memo_attach_get") {
      return jsonResponse({
        ok: true,
        data: memoAttachGet((e.parameter && e.parameter.id) || ""),
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
    if (type === "memo_notes") {
      const limit = parseInt((e.parameter && e.parameter.limit) || "100", 10);
      const offset = parseInt((e.parameter && e.parameter.offset) || "0", 10);
      return jsonResponse({ ok: true, data: pullMemoNotes(limit, offset) });
    }
    if (type === "memo_search") {
      const q = (e.parameter && e.parameter.q) || "";
      // type パラメータはルーティング用なので、種別フィルタは entry_type パラメータで受け取る
      const entryType = (e.parameter && e.parameter.entry_type) || "all";
      return jsonResponse({ ok: true, data: pullMemoSearch(q, entryType) });
    }
    if (type === "memo_day") {
      const date = (e.parameter && e.parameter.date) || "";
      return jsonResponse({ ok: true, data: { entries: pullMemoDay(date) } });
    }
    if (type === "memo_all") {
      const since = (e.parameter && e.parameter.since) || "";
      const limit = parseInt((e.parameter && e.parameter.limit) || "500", 10);
      return jsonResponse({ ok: true, data: pullMemoAll(since, limit) });
    }
    if (type === "habit_items") {
      return jsonResponse({ ok: true, data: { items: pullHabitItems() } });
    }
    if (type === "habit_day") {
      const date = (e.parameter && e.parameter.date) || "";
      return jsonResponse({ ok: true, data: { values: pullHabitDay(date) } });
    }
    if (type === "habit_range") {
      const from = (e.parameter && e.parameter.from) || "";
      const to = (e.parameter && e.parameter.to) || "";
      return jsonResponse({ ok: true, data: { days: pullHabitRange(from, to) } });
    }
    if (type === "meal_month") {
      const month = (e.parameter && e.parameter.month) || "";
      return jsonResponse({ ok: true, data: { days: pullMealMonth(month) } });
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
      try { body = JSON.parse(e.postData.contents); }
      catch (error) {
        // V8's JSON error may include a fragment containing health data or a key.
        return jsonResponse({ ok: false, error: "Invalid JSON request" });
      }
    }
    const type = body.type || (e && e.parameter && e.parameter.type) || "";

    if (type === "health_bridge_upload") {
      return jsonResponse({ ok: true, data: healthBridgeUpload(body) });
    }
    if (type === "health_bridge_read") {
      return jsonResponse({ ok: true, data: healthBridgeRead(body) });
    }
    if (type === "health_bridge_ack") {
      return jsonResponse({ ok: true, data: healthBridgeAck(body) });
    }
    if (type === "goal_node_upsert") {
      return jsonResponse({ ok: true, data: goalNodeUpsert(body.node) });
    }
    if (type === "goal_board_upsert") {
      return jsonResponse({ ok: true, data: goalBoardUpsert(body.board) });
    }
    if (type === "goal_item_upsert") {
      return jsonResponse({ ok: true, data: goalItemUpsert(body.item) });
    }
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
    if (type === "memo_url_fetch") {
      return jsonResponse({ ok: true, data: memoUrlFetch(body.url || "") });
    }
    if (type === "memo_attach") {
      return jsonResponse({
        ok: true,
        data: memoAttachSave(body.name || "", body.mime || "", body.data || ""),
      });
    }
    if (type === "memo_inbox_write") {
      return jsonResponse({
        ok: true,
        data: memoInboxWrite(body.entry_id || "", body.date || ""),
      });
    }
    if (type === "habit_items_upsert") {
      return jsonResponse({ ok: true, data: habitItemsUpsert(body.items) });
    }
    if (type === "habit_day_upsert") {
      return jsonResponse({
        ok: true,
        data: habitDayUpsert(body.date || "", body.values, body.set, body.del),
      });
    }
    if (type === "meal_day_upsert") {
      return jsonResponse({
        ok: true,
        data: mealDayUpsert(body.date || "", body.slots, body.set),
      });
    }
    if (type === "share_add") {
      return jsonResponse({
        ok: true,
        data: shareAdd(body.url || "", body.title || "", body.source || "ios_share"),
      });
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
    pinned:
      task.pinned != null
        ? isDeletedTruthy(task.pinned)
          ? 1
          : 0
        : isDeletedTruthy(base.pinned)
          ? 1
          : 0,
    sort_order:
      task.sort_order != null ? Number(task.sort_order) || 0 : Number(base.sort_order) || 0,
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

// ---------- Habit / Meal operations ----------
// 1日1行。値はJSON文字列。日付(またはid)で1行だけ読み書きする。

function isYmd(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}

function upsertJsonRow(sheetName, headers, key, obj) {
  const sheet = getSheet(sheetName, headers);
  const now = nowJstString();
  const rowIdx = findRowIndexById(sheet, key);
  const values = [key, JSON.stringify(obj), now];
  if (rowIdx > 0) {
    sheet.getRange(rowIdx, 1, 1, headers.length).setValues([values]);
  } else {
    sheet.appendRow(values);
  }
  return { key: key, updated_at: now };
}

function readJsonRow(sheetName, headers, key) {
  const sheet = getSheet(sheetName, headers);
  const rowIdx = findRowIndexById(sheet, key);
  if (rowIdx <= 0) return null;
  const row = readRowAt(sheet, rowIdx, headers);
  try {
    return JSON.parse(String(row.json || "null"));
  } catch (err) {
    return null;
  }
}

function pullHabitItems() {
  const v = readJsonRow(HABIT_ITEMS_SHEET, HABIT_ITEMS_HEADERS, "items");
  return Array.isArray(v) ? v : null;
}

function habitItemsUpsert(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("items required");
  }
  return upsertJsonRow(HABIT_ITEMS_SHEET, HABIT_ITEMS_HEADERS, "items", items);
}

function pullHabitDay(dateStr) {
  if (!isYmd(dateStr)) throw new Error("date must be yyyy-MM-dd");
  const v = readJsonRow(HABIT_DAYS_SHEET, HABIT_DAYS_HEADERS, dateStr);
  return v && typeof v === "object" ? v : null;
}

// from〜to（両端を含む）の日ごとの記録をまとめて返す。グラフ・履歴用
function pullHabitRange(from, to) {
  if (!isYmd(from) || !isYmd(to)) throw new Error("from/to must be yyyy-MM-dd");
  const sheet = getSheet(HABIT_DAYS_SHEET, HABIT_DAYS_HEADERS);
  const rows = readAllRows(sheet, HABIT_DAYS_HEADERS);
  const out = {};
  for (let i = 0; i < rows.length; i++) {
    const d = formatDateCell(rows[i].date, "yyyy-MM-dd");
    if (d < from || d > to) continue;
    try {
      const v = JSON.parse(String(rows[i].json || "null"));
      if (v && typeof v === "object") out[d] = v;
    } catch (err) {
      /* 壊れた行は飛ばす */
    }
  }
  return out;
}

// 変えた項目だけ受け取って、保存済みの内容に重ねる（その日をまるごと上書きしない）
// set: {項目ID: 値}　del: [項目ID]　旧形式の values は「追加・更新だけ」として扱い、消さない
function habitDayUpsert(dateStr, values, set, del) {
  if (!isYmd(dateStr)) throw new Error("date must be yyyy-MM-dd");
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const cur = readJsonRow(HABIT_DAYS_SHEET, HABIT_DAYS_HEADERS, dateStr);
    const next = cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {};
    const add = set && typeof set === "object" ? set : values && typeof values === "object" ? values : {};
    Object.keys(add).forEach(function (k) {
      next[k] = add[k];
    });
    (Array.isArray(del) ? del : []).forEach(function (k) {
      delete next[k];
    });
    return upsertJsonRow(HABIT_DAYS_SHEET, HABIT_DAYS_HEADERS, dateStr, next);
  } finally {
    lock.releaseLock();
  }
}

function pullMealMonth(monthStr) {
  if (!/^\d{4}-\d{2}$/.test(String(monthStr || ""))) {
    throw new Error("month must be yyyy-MM");
  }
  const sheet = getSheet(MEAL_SHEET, MEAL_HEADERS);
  const rows = readAllRows(sheet, MEAL_HEADERS);
  const out = {};
  for (let i = 0; i < rows.length; i++) {
    const d = String(rows[i].date || "");
    if (d.indexOf(monthStr + "-") !== 0) continue;
    try {
      out[d] = JSON.parse(String(rows[i].json || "null"));
    } catch (err) {
      /* 壊れた行は飛ばす */
    }
  }
  return out;
}

// 変えた区分だけ受け取って、保存済みの内容に重ねる（その日をまるごと上書きしない）
// set: {区分: {time, text}}　旧形式の slots も、入っている区分だけを重ねる
function mealDayUpsert(dateStr, slots, set) {
  if (!isYmd(dateStr)) throw new Error("date must be yyyy-MM-dd");
  const add = set && typeof set === "object" ? set : slots && typeof slots === "object" ? slots : null;
  if (!add) throw new Error("set required");
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = getSheet(MEAL_SHEET, MEAL_HEADERS);
    const rowIdx = findRowIndexById(sheet, dateStr);
    let cur = null;
    if (rowIdx > 0) {
      try {
        cur = JSON.parse(String(readRowAt(sheet, rowIdx, MEAL_HEADERS).json || "null"));
      } catch (err) {
        cur = null;
      }
    }
    const next = cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {};
    Object.keys(add).forEach(function (k) {
      next[k] = add[k];
    });
    return upsertJsonRow(MEAL_SHEET, MEAL_HEADERS, dateStr, next);
  } finally {
    lock.releaseLock();
  }
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
  if (MEMO_ALLOWED_TYPES.indexOf(entryType) < 0) {
    throw new Error("entry_type must be one of: " + MEMO_ALLOWED_TYPES.join("/"));
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
    claude_taken: takenValue(base.claude_taken),
    pinned:
      entry.pinned != null
        ? (isDeletedTruthy(entry.pinned) ? 1 : 0)
        : (isDeletedTruthy(base.pinned) ? 1 : 0),
    sort_order:
      entry.sort_order != null
        ? Number(entry.sort_order) || 0
        : Number(base.sort_order) || 0,
    archived:
      entry.archived != null
        ? (isDeletedTruthy(entry.archived) ? 1 : 0)
        : (isDeletedTruthy(base.archived) ? 1 : 0),
  };

  const values = MEMO_HEADERS.map((h) => merged[h]);
  if (rowIdx > 0) {
    sheet.getRange(rowIdx, 1, 1, MEMO_HEADERS.length).setValues([values]);
  } else {
    sheet.appendRow(values);
  }
  return normalizeMemoOut(merged);
}

// ノート／あとで読む のみ（journal除外）を、新しい順で返す
function pullMemoNotes(limit, offset) {
  const lim = isNaN(limit) || limit <= 0 ? 100 : Math.min(limit, 500);
  const off = isNaN(offset) || offset < 0 ? 0 : offset;
  const sheet = getSheet(MEMO_SHEET, MEMO_HEADERS);
  const rows = readAllRows(sheet, MEMO_HEADERS);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.id) continue;
    if (isDeletedTruthy(row.deleted)) continue;
    const type = String(row.entry_type || "");
    if (type !== "note" && type !== "read_later") continue;
    out.push(normalizeMemoOut(row));
  }
  out.sort((a, b) => {
    const ua = a.updated_at || a.created_at || "";
    const ub = b.updated_at || b.created_at || "";
    return ua < ub ? 1 : ua > ub ? -1 : 0;
  });
  const total = out.length;
  const slice = out.slice(off, off + lim);
  return { entries: slice, total: total, limit: lim, offset: off };
}

// 全文検索（title + body + tags）、entry_typeフィルタ可（all/journal/note/read_later）
function pullMemoSearch(q, entryType) {
  const sheet = getSheet(MEMO_SHEET, MEMO_HEADERS);
  const rows = readAllRows(sheet, MEMO_HEADERS);
  const needle = String(q || "").toLowerCase().trim();
  const filterType = String(entryType || "all");
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.id) continue;
    if (isDeletedTruthy(row.deleted)) continue;
    const type = String(row.entry_type || "");
    if (MEMO_ALLOWED_TYPES.indexOf(type) < 0) continue;
    if (filterType !== "all" && type !== filterType) continue;
    if (needle) {
      const hay = (
        String(row.title || "") +
        "\n" +
        String(row.body || "") +
        "\n" +
        String(row.tags || "")
      ).toLowerCase();
      if (hay.indexOf(needle) < 0) continue;
    }
    out.push(normalizeMemoOut(row));
  }
  out.sort((a, b) => {
    const ua = a.updated_at || a.created_at || "";
    const ub = b.updated_at || b.created_at || "";
    return ua < ub ? 1 : ua > ub ? -1 : 0;
  });
  return { entries: out, total: out.length };
}

// 指定日の全種別エントリを hour_slot 昇順で返す（Memoタブの時間軸ビュー用）
function pullMemoDay(dateStr) {
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
    const type = String(row.entry_type || "");
    if (MEMO_ALLOWED_TYPES.indexOf(type) < 0) continue;
    const dateVal = formatDateCell(row.date, "yyyy-MM-dd");
    if (dateVal !== dateStr) continue;
    out.push(normalizeMemoOut(row));
  }
  out.sort((a, b) => {
    const ha = parseInt(a.hour_slot, 10);
    const hb = parseInt(b.hour_slot, 10);
    if (!isNaN(ha) && !isNaN(hb) && ha !== hb) return ha - hb;
    return (a.created_at || "") < (b.created_at || "") ? -1 : 1;
  });
  return out;
}

// URL のタイトル取得（OG:title → <title> の順）
// 取得失敗時は title="" で返す（エラーにしない）
function memoUrlFetch(url) {
  const u = String(url || "").trim();
  if (!u) return { title: "", url: "", error: "url required" };
  if (!/^https?:\/\//i.test(u)) {
    return { title: "", url: u, error: "scheme not allowed" };
  }
  try {
    const res = UrlFetchApp.fetch(u, {
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: true,
      method: "get",
      headers: { "User-Agent": "Mozilla/5.0 system-techo-v3" },
    });
    const code = res.getResponseCode();
    if (code < 200 || code >= 400) {
      return { title: "", url: u, error: "http " + code };
    }
    const html = res.getContentText();
    const title = extractTitleFromHtml(html);
    return { title: title, url: u };
  } catch (err) {
    return { title: "", url: u, error: String(err) };
  }
}

function extractTitleFromHtml(html) {
  if (!html) return "";
  // og:title
  const og = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
  );
  if (og && og[1]) return decodeHtmlEntities(og[1]).trim();
  const og2 = html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
  );
  if (og2 && og2[1]) return decodeHtmlEntities(og2[1]).trim();
  // <title>
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m && m[1]) return decodeHtmlEntities(m[1]).replace(/\s+/g, " ").trim();
  return "";
}

function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// Claude 取込処理。claude_taken=1 にマーク。
// INBOX_FOLDER_ID が設定されていれば Drive に Markdown を書き出す。
function memoInboxWrite(entryId, dateStr) {
  const sheet = getSheet(MEMO_SHEET, MEMO_HEADERS);
  const rows = readAllRows(sheet, MEMO_HEADERS);
  const targets = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.id) continue;
    if (isDeletedTruthy(row.deleted)) continue;
    const type = String(row.entry_type || "");
    if (MEMO_ALLOWED_TYPES.indexOf(type) < 0) continue;
    if (entryId) {
      if (String(row.id) === String(entryId)) targets.push({ row: row, idx: i + 2 });
    } else if (dateStr) {
      const dateVal = formatDateCell(row.date, "yyyy-MM-dd");
      if (dateVal === dateStr) targets.push({ row: row, idx: i + 2 });
    }
  }
  if (targets.length === 0) {
    return { ok: false, taken: 0, not_found: true };
  }
  const now = nowJstString();
  let driveWrittenCount = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    t.row.claude_taken = now;
    t.row.updated_at = now;
    const values = MEMO_HEADERS.map((h) => (t.row[h] != null ? t.row[h] : ""));
    sheet.getRange(t.idx, 1, 1, MEMO_HEADERS.length).setValues([values]);
    if (INBOX_FOLDER_ID) {
      try {
        writeInboxMarkdown(t.row);
        driveWrittenCount++;
      } catch (err) {
        console.warn("inbox write failed: " + t.row.id + " - " + err);
      }
    }
  }
  return {
    ok: true,
    taken: targets.length,
    drive_written: driveWrittenCount,
    drive_folder_configured: !!INBOX_FOLDER_ID,
  };
}

function writeInboxMarkdown(row) {
  const folder = DriveApp.getFolderById(INBOX_FOLDER_ID);
  const dateVal = formatDateCell(row.date, "yyyy-MM-dd");
  const safeTitle = String(row.title || "untitled").replace(/[\/\\:?*"<>|]/g, "_").slice(0, 40);
  const filename = dateVal + "_" + String(row.entry_type || "memo") + "_" + safeTitle + ".md";
  const md = [
    "---",
    "id: " + row.id,
    "type: " + row.entry_type,
    "date: " + dateVal,
    "hour_slot: " + (row.hour_slot || ""),
    "tags: " + (row.tags || ""),
    "created_at: " + formatDateCell(row.created_at, "yyyy-MM-dd HH:mm"),
    "---",
    "",
    "# " + (row.title || "(無題)"),
    "",
    String(row.body || ""),
  ].join("\n");
  folder.createFile(filename, md, MimeType.PLAIN_TEXT);
}

// ---------- iOSショートカット共有シート連携 ----------
// POST {type:"share_add", url, title(任意), source(任意)}
// - http(s) 以外のURLは拒否
// - title が空の場合は memoUrlFetch 相当の処理でタイトル取得を試みる（失敗時は空のまま）
// - memoシートに entry_type=read_later で新規追加（既存upsertロジックを使う）
// - body には "URL" を格納（タイトルは title フィールドへ）
function shareAdd(url, title, source) {
  const u = String(url || "").trim();
  if (!u) throw new Error("url required");
  if (!/^https?:\/\//i.test(u)) throw new Error("scheme not allowed (http/https only)");

  let resolvedTitle = String(title || "").trim();
  if (!resolvedTitle) {
    try {
      const fetched = memoUrlFetch(u);
      if (fetched && fetched.title) resolvedTitle = String(fetched.title).trim();
    } catch (err) {
      // タイトル取得失敗は致命的ではない。空のまま進める。
      console.warn("share_add title fetch failed: " + err);
    }
  }
  if (!resolvedTitle) resolvedTitle = u;

  // 今日の日付（JST）を date に、現在の時刻帯を hour_slot に
  const todayStr = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");
  const hourStr = Utilities.formatDate(new Date(), "Asia/Tokyo", "HH");

  const entry = {
    entry_type: "read_later",
    date: todayStr,
    hour_slot: hourStr,
    title: resolvedTitle,
    body: u,
    tags: String(source || "ios_share"),
  };
  const saved = memoUpsert(entry);
  return { id: saved.id, title: saved.title, url: u };
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
    pinned: isDeletedTruthy(row.pinned) ? 1 : 0,
    sort_order: Number(row.sort_order) || 0,
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
    claude_taken: takenValue(row.claude_taken),
    pinned: isDeletedTruthy(row.pinned) ? 1 : 0,
    sort_order: Number(row.sort_order) || 0,
    archived: isDeletedTruthy(row.archived) ? 1 : 0,
  };
}

// Memoタブ一覧用：指定日以降の全種別（journal/note/read_later）を返す
// since が空なら全件。新しい順。
function pullMemoAll(sinceStr, limit) {
  const sheet = getSheet(MEMO_SHEET, MEMO_HEADERS);
  const rows = readAllRows(sheet, MEMO_HEADERS);
  const lim = isNaN(limit) || limit <= 0 ? 500 : Math.min(limit, 2000);
  const sinceOk = /^\d{4}-\d{2}-\d{2}$/.test(String(sinceStr || ""));
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.id) continue;
    if (isDeletedTruthy(row.deleted)) continue;
    const type = String(row.entry_type || "");
    if (MEMO_ALLOWED_TYPES.indexOf(type) < 0) continue;
    if (sinceOk) {
      const d = formatDateCell(row.date, "yyyy-MM-dd");
      if (d && d < sinceStr) continue;
    }
    out.push(normalizeMemoOut(row));
  }
  out.sort((a, b) => {
    const ua = a.updated_at || a.created_at || "";
    const ub = b.updated_at || b.created_at || "";
    return ua < ub ? 1 : ua > ub ? -1 : 0;
  });
  return { entries: out.slice(0, lim), total: out.length };
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


// 取込済の値。日時が入っていればその文字列、旧データの1は1のまま、未取込は0
function takenValue(v) {
  if (v instanceof Date) return Utilities.formatDate(v, "Asia/Tokyo", "yyyy-MM-dd HH:mm");
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v.trim())) return v.trim();
  return isDeletedTruthy(v) ? 1 : 0;
}

// ---------- メモの添付ファイル ----------
// 追加の許可が要らないよう、手帳のスプレッドシートの専用シートに保存する。
// 1つのセルは5万字までなので、base64を4万字ずつに割って複数行に入れる。
const ATTACH_SHEET = "メモ添付";
const ATTACH_HEADERS = ["id", "name", "mime", "idx", "data"];
const ATTACH_CHUNK = 40000;

function memoAttachSave(name, mime, b64) {
  if (!b64) throw new Error("data is empty");
  const sheet = getSheet(ATTACH_SHEET, ATTACH_HEADERS);
  const id = "a" + Utilities.getUuid().replace(/-/g, "").slice(0, 16);
  const rows = [];
  for (let i = 0, n = 0; i < b64.length; i += ATTACH_CHUNK, n++) {
    rows.push([id, name || "file", mime || "application/octet-stream", n, b64.slice(i, i + ATTACH_CHUNK)]);
  }
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, ATTACH_HEADERS.length).setValues(rows);
  return { id: id, name: name || "file", mime: mime || "application/octet-stream" };
}

function memoAttachGet(id) {
  if (!id) throw new Error("id is empty");
  const sheet = getSheet(ATTACH_SHEET, ATTACH_HEADERS);
  const last = sheet.getLastRow();
  if (last < 2) throw new Error("not found");
  const values = sheet.getRange(2, 1, last - 1, ATTACH_HEADERS.length).getValues();
  const parts = values.filter((r) => String(r[0]) === String(id));
  if (parts.length === 0) throw new Error("not found");
  parts.sort((x, y) => Number(x[3]) - Number(y[3]));
  return {
    id: id,
    name: String(parts[0][1]),
    mime: String(parts[0][2]),
    data: parts.map((r) => String(r[4])).join(""),
  };
}

function memoAttachTest() {
  const src = Utilities.base64Encode("hello".repeat(20000)); // 複数行に割れる大きさ
  const up = memoAttachSave("test.txt", "text/plain", src);
  const got = memoAttachGet(up.id);
  // 試験行を消す
  const sheet = getSheet(ATTACH_SHEET, ATTACH_HEADERS);
  const vals = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 1).getValues();
  for (let i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][0]) === up.id) sheet.deleteRow(i + 2);
  }
  return { same: got.data === src, len: got.data.length };
}


// ---------- Goals / Vision board ----------
// New entities are isolated JSON rows. Existing sheets and cache schemas are untouched.
const GOAL_NODES_SHEET = "goal_nodes";
const GOAL_BOARDS_SHEET = "goal_boards";
const GOAL_ITEMS_SHEET = "goal_board_items";
const GOAL_JSON_HEADERS = ["id", "json", "updated_at"];

function pullGoals() {
  return {
    nodes: goalReadRows(GOAL_NODES_SHEET),
    boards: goalReadRows(GOAL_BOARDS_SHEET),
    items: goalReadRows(GOAL_ITEMS_SHEET),
  };
}

function goalReadRows(sheetName) {
  const rows = readAllRows(getSheet(sheetName, GOAL_JSON_HEADERS), GOAL_JSON_HEADERS);
  return rows.filter((row) => row.id !== "" && row.id != null).map((row) => {
    let value;
    try { value = JSON.parse(String(row.json)); }
    catch (err) { throw new Error("Invalid JSON in " + sheetName + ": " + row.id); }
    if (!value || typeof value !== "object" || Array.isArray(value) || value.id !== String(row.id)) {
      throw new Error("Invalid record in " + sheetName + ": " + row.id);
    }
    return value; // Include tombstones and unknown fields for non-destructive sync.
  });
}

function goalWithLock(action) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return action(); }
  finally { lock.releaseLock(); }
}

function goalInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("entity must be an object");
  return input;
}

function goalId(value, required) {
  if (value == null || value === "") {
    if (required) throw new Error("id required");
    return "";
  }
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value)) throw new Error("invalid id");
  return value;
}

function goalText(value, fallback, limit, label) {
  const text = value === undefined ? fallback : value;
  if (typeof text !== "string" || text.length > limit) throw new Error("invalid " + label);
  return text;
}

function goalNumber(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") throw new Error("invalid " + label);
  const n = Number(value);
  if (!isFinite(n) || n < min || n > max) throw new Error("invalid " + label);
  return n;
}

function goalWriteRow(sheetName, record) {
  const json = JSON.stringify(record);
  if (json.length > 40000) throw new Error("goal record is too large");
  const sheet = getSheet(sheetName, GOAL_JSON_HEADERS);
  const row = findRowIndexById(sheet, record.id);
  const values = [record.id, json, record.updated_at];
  if (row > 0) sheet.getRange(row, 1, 1, GOAL_JSON_HEADERS.length).setValues([values]);
  else sheet.appendRow(values);
  return record;
}

function goalNodeUpsert(input) {
  return goalWithLock(() => {
    goalInput(input);
    const id = goalId(input.id, true);
    const rows = goalReadRows(GOAL_NODES_SHEET);
    const base = rows.find((row) => row.id === id) || {};
    const next = { ...base, ...input, id };
    if (["purpose", "goal", "means"].indexOf(next.kind) < 0) throw new Error("invalid node.kind");
    if (base.kind && base.kind !== next.kind) throw new Error("node.kind cannot change");
    next.parent_id = goalId(next.parent_id, false);
    next.title = goalText(next.title, "", 500, "node.title");
    if (!next.title.trim()) throw new Error("node.title required");
    next.description = goalText(next.description, "", 20000, "node.description");
    next.cover_item_id = goalId(next.cover_item_id, false);
    next.sort_order = goalNumber(next.sort_order, 0, -1e9, 1e9, "node.sort_order");
    next.deleted = isDeletedTruthy(next.deleted) ? 1 : 0;
    if (next.deleted) {
      if (rows.some((row) => row.parent_id === id && !isDeletedTruthy(row.deleted))) throw new Error("remove or move child nodes first");
    } else {
      const byId = new Map(rows.map((row) => [row.id, row]));
      const seen = new Set([id]);
      let parentId = next.parent_id;
      while (parentId) {
        if (seen.has(parentId)) throw new Error("node parent cycle");
        seen.add(parentId);
        const ancestor = byId.get(parentId);
        if (!ancestor || isDeletedTruthy(ancestor.deleted)) throw new Error("node parent not found");
        parentId = ancestor.parent_id;
      }
      if (next.kind === "purpose") {
        if (next.parent_id) throw new Error("purpose must not have a parent");
      } else {
        const parent = byId.get(next.parent_id);
        const requiredKind = next.kind === "goal" ? "purpose" : "goal";
        if (!parent || parent.kind !== requiredKind) throw new Error("invalid parent kind for " + next.kind);
      }
      if (next.cover_item_id && next.cover_item_id !== base.cover_item_id) {
        if (next.kind !== "goal") throw new Error("only goals can have a cover item");
        const cover = goalReadRows(GOAL_ITEMS_SHEET).find((item) => item.id === next.cover_item_id);
        if (!cover || isDeletedTruthy(cover.deleted) || cover.goal_id !== id) throw new Error("cover item must belong to this goal");
      }
    }
    const now = nowJstString();
    next.created_at = base.created_at || (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(input.created_at || "")) ? input.created_at : now);
    next.updated_at = now;
    return goalWriteRow(GOAL_NODES_SHEET, next);
  });
}

function goalBoardUpsert(input) {
  return goalWithLock(() => {
    goalInput(input);
    const id = goalId(input.id, true);
    const base = goalReadRows(GOAL_BOARDS_SHEET).find((row) => row.id === id) || {};
    const next = { ...base, ...input, id };
    next.title = goalText(next.title, "ビジョンボード", 500, "board.title");
    next.background = next.background === undefined ? "cork" : next.background;
    if (typeof next.background !== "string" && (!next.background || typeof next.background !== "object" || Array.isArray(next.background))) throw new Error("invalid board.background");
    next.width = goalNumber(next.width, 1200, 1, 100000, "board.width");
    next.height = goalNumber(next.height, 1600, 1, 100000, "board.height");
    next.deleted = isDeletedTruthy(next.deleted) ? 1 : 0;
    next.updated_at = nowJstString();
    return goalWriteRow(GOAL_BOARDS_SHEET, next);
  });
}

function goalItemUpsert(input) {
  return goalWithLock(() => {
    goalInput(input);
    const id = goalId(input.id, true);
    const base = goalReadRows(GOAL_ITEMS_SHEET).find((row) => row.id === id) || {};
    const next = { ...base, ...input, id };
    next.board_id = goalId(next.board_id, true);
    next.attachment_id = goalId(next.attachment_id, true);
    next.name = goalText(next.name, "image.jpg", 500, "item.name");
    next.mime = goalText(next.mime, "image/jpeg", 100, "item.mime");
    next.caption = goalText(next.caption, "", 20000, "item.caption");
    next.goal_id = goalId(next.goal_id, false);
    next.x = goalNumber(next.x, 0, -100000, 100000, "item.x");
    next.y = goalNumber(next.y, 0, -100000, 100000, "item.y");
    next.width = goalNumber(next.width, 220, 1, 100000, "item.width");
    next.height = goalNumber(next.height, 180, 1, 100000, "item.height");
    next.rotation = goalNumber(next.rotation, 0, -360, 360, "item.rotation");
    next.z_index = goalNumber(next.z_index, 0, -1e9, 1e9, "item.z_index");
    next.deleted = isDeletedTruthy(next.deleted) ? 1 : 0;
    if (!next.deleted) {
      // Existing references may point to logical deletions. Preserve those records
      // while allowing an unrelated caption/position edit; validate new links.
      if (!base.id || next.board_id !== base.board_id) {
        const board = goalReadRows(GOAL_BOARDS_SHEET).find((row) => row.id === next.board_id);
        if (!board || isDeletedTruthy(board.deleted)) throw new Error("item board not found");
      }
      if (next.goal_id && (!base.id || next.goal_id !== base.goal_id)) {
        const goal = goalReadRows(GOAL_NODES_SHEET).find((row) => row.id === next.goal_id);
        if (!goal || isDeletedTruthy(goal.deleted) || goal.kind !== "goal") throw new Error("item goal not found");
      }
      if (base.id && next.goal_id !== base.goal_id) {
        const usedCover = goalReadRows(GOAL_NODES_SHEET).some((row) => !isDeletedTruthy(row.deleted) && row.cover_item_id === id && row.id !== next.goal_id);
        if (usedCover) throw new Error("clear the previous goal cover before relinking this item");
      }
    }
    next.updated_at = nowJstString();
    return goalWriteRow(GOAL_ITEMS_SHEET, next);
  });
}


// ---------- Health bridge: temporary, per-request handoff only ----------
// No Sheets or Properties reads/writes here. Only the PWA's existing habit PATCH
// flow can persist the selected day's values after its edit/date guards pass.
const HEALTH_BRIDGE_TTL_MS = 10 * 60 * 1000;
const HEALTH_BRIDGE_FIELDS = {
  weight: { unit: "kg", min: 0, max: 500, exclusiveMin: true },
  bodyFat: { unit: "%", min: 0, max: 100 },
  kcal: { unit: "kcal", min: 0, max: 100000 },
  steps: { unit: "count", min: 0, max: 1000000, integer: true },
};

function healthBridgeRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid health request");
  if (typeof body.request_id !== "string" || !/^[A-Za-z0-9_-]{32,96}$/.test(body.request_id)) {
    throw new Error("invalid health request id");
  }
  if (typeof body.pair_key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.pair_key)) {
    throw new Error("invalid health pairing key");
  }
  const match = typeof body.date === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(body.date);
  if (!match) throw new Error("invalid health date");
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error("invalid health date");
  }
  const now = Date.now();
  if (typeof body.issued_at !== "number" || !isFinite(body.issued_at) || !Number.isInteger(body.issued_at)
      || body.issued_at <= 0 || body.issued_at - now > 2 * 60 * 1000) {
    throw new Error("invalid health request time");
  }
  if (now - body.issued_at >= HEALTH_BRIDGE_TTL_MS) throw new Error("health request expired");
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, body.pair_key, Utilities.Charset.UTF_8)
    .map((value) => ("0" + ((value + 256) % 256).toString(16)).slice(-2)).join("");
  return { request_id: body.request_id, date: body.date, issued_at: body.issued_at, key_hash: hash };
}

function healthBridgeWithLock(action) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return action(); }
  finally { lock.releaseLock(); }
}

function healthBridgeLoad(cache, request) {
  const raw = cache.get("health_bridge:" + request.request_id);
  if (raw == null) return null; // Cache may evict early. Waiting never means a zero value.
  let entry;
  try { entry = JSON.parse(raw); }
  catch (error) { throw new Error("invalid health handoff state"); }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || entry.request_id !== request.request_id || !["ready", "consumed"].includes(entry.status)
      || typeof entry.expires_at !== "number" || !isFinite(entry.expires_at)) {
    throw new Error("invalid health handoff state");
  }
  if (entry.key_hash !== request.key_hash || entry.date !== request.date || entry.issued_at !== request.issued_at) {
    throw new Error("health request does not match");
  }
  if (entry.expires_at <= Date.now()) throw new Error("health request expired");
  healthBridgeMetadata(entry);
  return entry;
}

// Optional metadata identifies the sender's protocol, not a device or a metric.
// Legacy results stay readable; version comparison belongs to the client.
function healthBridgeMetadata(data) {
  const own = (key) => Object.prototype.hasOwnProperty.call(data, key);
  const metadata = {};
  if (own("stepsSource")) {
    if (data.stepsSource !== "apple_watch") throw new Error("invalid health steps source");
    metadata.stepsSource = "apple_watch";
  }
  const hasShortcut = own("shortcutVersion"), hasProtocol = own("protocolVersion");
  if (hasShortcut !== hasProtocol) throw new Error("incomplete health protocol metadata");
  if (hasShortcut) {
    const version = data.shortcutVersion;
    if (typeof version !== "string" || version.length > 32 || version.trim() !== version
        || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("invalid health shortcut version");
    if (!Number.isInteger(data.protocolVersion) || data.protocolVersion !== 1) throw new Error("unsupported health protocol version");
    metadata.shortcutVersion = version;
    metadata.protocolVersion = 1;
  }
  return metadata;
}

function healthBridgeValues(values, units) {
  if (!values || typeof values !== "object" || Array.isArray(values)
      || !units || typeof units !== "object" || Array.isArray(units)) {
    throw new Error("invalid health metrics");
  }
  const keys = Object.keys(values), unitKeys = Object.keys(units);
  if (keys.length !== unitKeys.length || unitKeys.some((key) => !Object.prototype.hasOwnProperty.call(values, key))) {
    throw new Error("health units do not match metrics");
  }
  const checked = {}, checkedUnits = {};
  keys.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(HEALTH_BRIDGE_FIELDS, key)) throw new Error("unsupported health metric");
    const rule = HEALTH_BRIDGE_FIELDS[key], value = values[key];
    if (typeof value !== "number" || !isFinite(value) || value < rule.min || value > rule.max
        || rule.exclusiveMin && value === rule.min || rule.integer && !Number.isInteger(value)) {
      throw new Error("invalid health metric value");
    }
    if (units[key] !== rule.unit) throw new Error("invalid health metric unit");
    checked[key] = value;
    checkedUnits[key] = rule.unit;
  });
  return { values: checked, units: checkedUnits };
}

function healthBridgeStore(cache, entry) {
  const remaining = entry.expires_at - Date.now();
  if (remaining <= 0) throw new Error("health request expired");
  const seconds = Math.min(600, Math.max(1, Math.floor(remaining / 1000)));
  cache.put("health_bridge:" + entry.request_id, JSON.stringify(entry), seconds);
}

function healthBridgeUpload(body) {
  const request = healthBridgeRequest(body);
  const metrics = healthBridgeValues(body.values, body.units);
  const metadata = healthBridgeMetadata(body);
  return healthBridgeWithLock(() => {
    const cache = CacheService.getScriptCache();
    const existing = healthBridgeLoad(cache, request);
    if (existing) {
      if (existing.status === "consumed") throw new Error("health request already consumed");
      return { status: "ready", date: request.date, issued_at: request.issued_at }; // Retry preserves the first result.
    }
    const entry = { ...request, status: "ready", expires_at: Math.min(request.issued_at + HEALTH_BRIDGE_TTL_MS,
      Date.now() + HEALTH_BRIDGE_TTL_MS), values: metrics.values, units: metrics.units, ...metadata };
    healthBridgeStore(cache, entry);
    return { status: "ready", date: request.date, issued_at: request.issued_at };
  });
}

function healthBridgeRead(body) {
  const request = healthBridgeRequest(body);
  return healthBridgeWithLock(() => {
    const entry = healthBridgeLoad(CacheService.getScriptCache(), request);
    if (!entry) return { status: "waiting", date: request.date };
    if (entry.status === "consumed") return { status: "consumed", date: request.date, issued_at: request.issued_at };
    const metrics = healthBridgeValues(entry.values, entry.units);
    return { status: "ready", date: request.date, issued_at: entry.issued_at, values: metrics.values, units: metrics.units,
      ...healthBridgeMetadata(entry) };
  });
}

function healthBridgeAck(body) {
  const request = healthBridgeRequest(body);
  return healthBridgeWithLock(() => {
    const cache = CacheService.getScriptCache();
    const entry = healthBridgeLoad(cache, request);
    if (!entry) return { status: "waiting", date: request.date };
    const marker = { request_id: request.request_id, date: request.date, issued_at: request.issued_at,
      key_hash: request.key_hash, expires_at: entry.expires_at, status: "consumed" };
    healthBridgeStore(cache, marker); // No values, units or sender metadata remain in the consumed marker.
    return { status: "consumed", date: request.date, issued_at: request.issued_at };
  });
}
