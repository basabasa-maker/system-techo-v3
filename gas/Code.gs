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
  "claude_taken",
  "pinned",
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
    if (type === "memo_url_fetch") {
      return jsonResponse({ ok: true, data: memoUrlFetch(body.url || "") });
    }
    if (type === "memo_inbox_write") {
      return jsonResponse({
        ok: true,
        data: memoInboxWrite(body.entry_id || "", body.date || ""),
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
    claude_taken: isDeletedTruthy(base.claude_taken) ? 1 : 0,
    pinned:
      entry.pinned != null
        ? (isDeletedTruthy(entry.pinned) ? 1 : 0)
        : (isDeletedTruthy(base.pinned) ? 1 : 0),
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
    t.row.claude_taken = 1;
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
    claude_taken: isDeletedTruthy(row.claude_taken) ? 1 : 0,
    pinned: isDeletedTruthy(row.pinned) ? 1 : 0,
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
