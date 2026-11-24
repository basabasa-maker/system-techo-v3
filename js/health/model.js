// Health bridge validation and partial-update selection. No storage, DOM or API access.
export const HEALTH_METRICS = Object.freeze({
  weight: Object.freeze({ unit: "kg", min: 0, max: 500, exclusiveMin: true }),
  bodyFat: Object.freeze({ unit: "%", min: 0, max: 100 }),
  kcal: Object.freeze({ unit: "kcal", min: 0, max: 100000 }),
  steps: Object.freeze({ unit: "count", min: 0, max: 1000000, integer: true }),
});

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const numericTypes = new Set(["number", "decimal", "integer"]);
const lifetimeMs = 10 * 60 * 1000;
const futureToleranceMs = 2 * 60 * 1000;

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validValue(key, value) {
  const rule = HEALTH_METRICS[key];
  return typeof value === "number" && Number.isFinite(value)
    && (rule.exclusiveMin ? value > rule.min : value >= rule.min)
    && value <= rule.max && (!rule.integer || Number.isInteger(value));
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateHealthValues(values, units) {
  if (!isRecord(values) || !isRecord(units)) throw new Error("Invalid health measurements");
  const keys = Object.keys(values);
  if (keys.length !== Object.keys(units).length) throw new Error("Health units do not match");
  const validated = {};
  for (const key of keys) {
    if (!own(HEALTH_METRICS, key) || !validValue(key, values[key])) {
      throw new Error("Invalid health measurement");
    }
    if (!own(units, key) || units[key] !== HEALTH_METRICS[key].unit) {
      throw new Error("Health units do not match");
    }
    validated[key] = Object.is(values[key], -0) ? 0 : values[key];
  }
  return validated;
}

export function healthBaseline(values) {
  const baseline = {};
  if (!isRecord(values)) return baseline;
  for (const key of Object.keys(HEALTH_METRICS)) {
    if (!own(values, key)) continue;
    const value = values[key];
    if (value === null || ["undefined", "string", "number", "boolean"].includes(typeof value)) {
      baseline[key] = value;
    }
  }
  return baseline;
}

export function selectHealthPatch(current, baseline, incoming, items) {
  const patch = {};
  if (!isRecord(current) || !isRecord(baseline) || !isRecord(incoming) || !Array.isArray(items)) return patch;
  for (const key of Object.keys(HEALTH_METRICS)) {
    if (!own(incoming, key) || !validValue(key, incoming[key])) continue;
    const item = items.find((entry) => entry?.id === key);
    if (!item || !numericTypes.has(item.type)) continue;
    if (Object.is(current[key], baseline[key]) && !Object.is(current[key], incoming[key])) {
      patch[key] = incoming[key];
    }
  }
  return patch;
}

export function validateHealthResult(result, request, now = Date.now()) {
  if (!isRecord(result)) throw new Error("Invalid health response");
  if (result.status === "waiting" || result.status === "consumed") return null;
  if (result.status !== "ready" || !isRecord(request)) throw new Error("Invalid health response");
  if (!validDate(request.date) || result.date !== request.date) throw new Error("Health response date does not match");
  const issuedAt = request.issued_at;
  if (!Number.isInteger(issuedAt) || issuedAt <= 0 || result.issued_at !== issuedAt || !Number.isFinite(now)) {
    throw new Error("Invalid health request timestamp");
  }
  if (now - issuedAt >= lifetimeMs || issuedAt - now > futureToleranceMs) throw new Error("Health request expired");
  return validateHealthValues(result.values, result.units);
}
