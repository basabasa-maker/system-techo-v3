// Goals use a separate cache. Existing task/memo/habit/meal stores stay intact.
import * as gas from "../gas-client.js";
import * as sync from "../sync.js";
import { nowJst } from "../date-util.js";
import {
  CACHE_KEY, DEFAULT_BOARD, ENTITY_GROUPS, goalSnapshot,
  validateNode, normalizeBoard, normalizeItem, mergeGoalSnapshot,
} from "./model.js";

// The small dependency seam makes persistence/race tests independent of the
// user's browser, IndexedDB and production API.
export function createGoalsRepository(options = {}) {
  const api = options.api || gas;
  const syncClient = options.syncClient || sync;
  const now = options.now || nowJst;
  let pullSequence = 0;
  const storage = () => options.storage || globalThis.localStorage;

  function loadGoals() {
    const raw = storage().getItem(CACHE_KEY);
    if (!raw) return goalSnapshot();
    try {
      return goalSnapshot(JSON.parse(raw));
    } catch (error) {
      throw new Error("目標の保存データを読めません。データを消さずに確認してください", { cause: error });
    }
  }

  function saveSnapshot(snapshot) {
    storage().setItem(CACHE_KEY, JSON.stringify(snapshot));
    return snapshot;
  }

  function defaultBoard() {
    return { ...DEFAULT_BOARD };
  }

  function saveRecord(group, input, validate, type) {
    const snapshot = loadGoals();
    const existing = snapshot[group].find((row) => row.id === input.id);
    const candidate = { ...existing, ...input, updated_at: now() };
    if (group === "nodes") candidate.created_at = existing?.created_at || input.created_at || candidate.updated_at;
    const saved = validate(candidate, snapshot);
    if (JSON.stringify(saved).length > 40000) throw new Error("保存内容が大きすぎます");
    const rows = snapshot[group].filter((row) => row.id !== saved.id);
    // Replacement in place keeps otherwise unmodified local ordering stable.
    const index = snapshot[group].findIndex((row) => row.id === saved.id);
    if (index < 0) rows.push(saved);
    else rows.splice(index, 0, saved);
    saveSnapshot({ ...snapshot, [group]: rows });
    // queue persists immediately; only sending waits, so callers can await
    // durability without waiting for a slow/offline network.
    return syncClient.queue({ type, payload: saved }, 300).then(() => saved);
  }

  function saveNode(node) {
    return saveRecord("nodes", node,
      (candidate, snapshot) => validateNode(candidate, snapshot.nodes, snapshot.items), "goal_node_upsert");
  }
  function saveBoard(board) {
    return saveRecord("boards", board,
      (candidate) => normalizeBoard(candidate), "goal_board_upsert");
  }
  function saveItem(item) {
    return saveRecord("items", item,
      (candidate, snapshot) => normalizeItem(candidate, snapshot.nodes, snapshot.boards), "goal_item_upsert");
  }

  async function pullGoals() {
    const sequence = ++pullSequence;
    await syncClient.flushAll().catch(() => {});
    const initial = loadGoals();
    const revisions = new Map();
    for (const [group, prefix] of Object.entries(ENTITY_GROUPS)) {
      for (const row of initial[group]) revisions.set(prefix + row.id, syncClient.revision(prefix + row.id));
    }
    const remote = await api.pullGoals();
    // An unsupported endpoint or malformed response must never erase a cache.
    if (!remote || !Object.keys(ENTITY_GROUPS).every((group) => Array.isArray(remote[group]))) {
      throw new Error("目標データの取得結果が正しくありません");
    }
    const pending = await syncClient.pendingKeys();
    if (sequence !== pullSequence) return loadGoals();
    return saveSnapshot(mergeGoalSnapshot(loadGoals(), remote, {
      pending, revisions, currentRevision: (key) => syncClient.revision(key),
    }));
  }

  return { loadGoals, saveNode, saveBoard, saveItem, pullGoals, defaultBoard };
}

const repository = createGoalsRepository();
export const loadGoals = (...args) => repository.loadGoals(...args);
export const saveNode = (...args) => repository.saveNode(...args);
export const saveBoard = (...args) => repository.saveBoard(...args);
export const saveItem = (...args) => repository.saveItem(...args);
export const pullGoals = (...args) => repository.pullGoals(...args);
export const defaultBoard = (...args) => repository.defaultBoard(...args);
