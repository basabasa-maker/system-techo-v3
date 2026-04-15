// system-techo-v3 GAS Web API
// Sprint 0: type=meta エンドポイントのみ実装。他は Sprint 1 以降で追加。
// 設計思想:
// - pullAll API は作らない（v1白紙化の教訓）
// - push系は1件upsertのみ
// - CALENDAR_IDS は basabasa-hq/システム手帳/config/calendar_ids.json を参照（Sprint 2で連携）

const SPREADSHEET_ID = "1pENt1pTtF9A3CV-VY0VnP8VlbNM5mPZW9tSAtE8YKXs";
const SCHEMA_VERSION = 1;

function doGet(e) {
  const type = (e && e.parameter && e.parameter.type) || "";
  try {
    if (type === "meta") {
      return jsonResponse({
        ok: true,
        data: {
          schema_version: SCHEMA_VERSION,
          sprint: 0,
          deployed_at: new Date().toISOString(),
        },
      });
    }
    return jsonResponse({
      ok: false,
      error: `Not implemented in Sprint 0: type=${type}`,
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  return jsonResponse({ ok: false, error: "Not implemented in Sprint 0" });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
