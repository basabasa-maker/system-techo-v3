// Owner-managed workbook copies. No body exports, sharing changes or retention deletion.
const BACKUP_CONFIG_KEY_ = 'sth_v3_backup_config';
const BACKUP_COPY_PREFIX_ = 'sth_v3_backup_copy_';
const BACKUP_HANDLER_ = 'systemTechoBackupDaily_';
const BACKUP_ERROR_MESSAGES_ = {
  STATE_INVALID: 'バックアップ設定の記録を確認できません。管理者が設定を確認してください。',
  STATE_WRITE_FAILED: 'バックアップ設定の記録を保存できませんでした。',
  COPY_FAILED: 'バックアップのコピーを作成できませんでした。以前のコピーは変更していません。',
  VERIFY_FAILED: '作成したコピーの構成を確認できませんでした。成功には数えていません。',
  REGISTRY_FAILED: '作成したコピーの記録を保存できませんでした。Google Driveも確認してください。',
  TRIGGER_SETUP_FAILED: '自動バックアップの設定を完了できませんでした。作成済みのコピーは残しています。',
  STATUS_UNAVAILABLE: 'バックアップの状態を確認できません。',
};

function backupFailure_(code) {
  const error = new Error(BACKUP_ERROR_MESSAGES_[code] || BACKUP_ERROR_MESSAGES_.STATE_INVALID);
  error.backupCode = code;
  return error;
}

function backupOwner_() {
  const active = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  const effective = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  if (!active || !effective || active !== effective) throw new Error('Google管理者本人のアカウントで開いてください。');
  return effective;
}

function backupDefaultConfig_() {
  return { version: 1, sourceId: SPREADSHEET_ID, enabled: false, ownerEmail: '', triggerUid: '', lastSuccessAt: '', lastErrorCode: '', hasBackups: false, lastDailyDate: '' };
}

function backupReadConfig_() {
  const raw = PropertiesService.getScriptProperties().getProperty(BACKUP_CONFIG_KEY_);
  if (raw === null) return backupDefaultConfig_();
  let state;
  try { state = JSON.parse(raw); } catch (_) { throw backupFailure_('STATE_INVALID'); }
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 1 || state.sourceId !== SPREADSHEET_ID
      || typeof state.enabled !== 'boolean' || typeof state.hasBackups !== 'boolean'
      || ['ownerEmail', 'triggerUid', 'lastSuccessAt', 'lastErrorCode', 'lastDailyDate'].some(key => typeof state[key] !== 'string')
      || (state.lastErrorCode && !Object.prototype.hasOwnProperty.call(BACKUP_ERROR_MESSAGES_, state.lastErrorCode))
      || (state.lastSuccessAt && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(state.lastSuccessAt))
      || (state.lastDailyDate && !/^\d{4}-\d{2}-\d{2}$/.test(state.lastDailyDate))
      || (state.enabled && (!state.ownerEmail || !state.triggerUid || !state.hasBackups || !state.lastSuccessAt))) throw backupFailure_('STATE_INVALID');
  return state;
}

function backupWriteConfig_(state) {
  try { PropertiesService.getScriptProperties().setProperty(BACKUP_CONFIG_KEY_, JSON.stringify(state)); }
  catch (_) { throw backupFailure_('STATE_WRITE_FAILED'); }
}

function backupRecordError_(state, code) {
  // A failure to record an error must not expose raw service errors or data.
  try { backupWriteConfig_(Object.assign({}, state, { lastErrorCode: code })); } catch (_) {}
}

function backupStoredTrigger_(state) {
  if (!state.triggerUid) return null;
  return ScriptApp.getProjectTriggers().find(trigger => String(trigger.getUniqueId()) === state.triggerUid
    && trigger.getHandlerFunction() === BACKUP_HANDLER_) || null;
}

function backupPublicStatus_(state) {
  return { enabled: !!(state.enabled && backupStoredTrigger_(state)), lastSuccessAt: state.lastSuccessAt,
    lastErrorCode: state.lastErrorCode, hasBackups: state.hasBackups };
}

// The only anonymous endpoint. Never return copy IDs, URLs, names, owner or data.
function getBackupStatus() {
  try { return backupPublicStatus_(backupReadConfig_()); }
  catch (error) { return { enabled: false, lastSuccessAt: '', lastErrorCode: error.backupCode === 'STATE_INVALID' ? 'STATE_INVALID' : 'STATUS_UNAVAILABLE', hasBackups: false }; }
}

function renderBackupAdminPage() {
  backupOwner_();
  return HtmlService.createHtmlOutputFromFile('BackupAdmin').setTitle('システム手帳・バックアップ管理');
}

function backupReadCopies_() {
  const properties = PropertiesService.getScriptProperties().getProperties();
  return Object.keys(properties).filter(key => key.indexOf(BACKUP_COPY_PREFIX_) === 0).map(key => {
    let record;
    try { record = JSON.parse(properties[key]); } catch (_) { throw backupFailure_('STATE_INVALID'); }
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || typeof record.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(record.id) || record.id === SPREADSHEET_ID
        || key !== BACKUP_COPY_PREFIX_ + record.id || record.sourceId !== SPREADSHEET_ID
        || typeof record.name !== 'string' || typeof record.createdAt !== 'string'
        || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(record.createdAt)
        || ['manual', 'daily', 'setup'].indexOf(record.cause) < 0 || ['created', 'verified'].indexOf(record.status) < 0) throw backupFailure_('STATE_INVALID');
    return record;
  }).sort((a, b) => a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1);
}

function backupAdminState_() {
  const state = backupReadConfig_();
  const records = backupReadCopies_();
  return Object.assign(backupPublicStatus_(state), { backupCount: records.length, automaticTime: '毎日3時台（日本時間）',
    backups: records.slice(0, 100).map(record => ({ id: record.id, name: record.name, createdAt: record.createdAt,
      cause: record.cause, status: record.status, url: 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(record.id) + '/edit' })) });
}

function getBackupAdminState() {
  backupOwner_();
  return backupAdminState_();
}

function backupWithLock_(work) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('バックアップを処理中です。少し待ってもう一度お試しください。');
  try { return work(); } finally { lock.releaseLock(); }
}

function backupCopy_(state, cause) {
  let stage = 'COPY_FAILED';
  try {
    const source = SpreadsheetApp.openById(SPREADSHEET_ID);
    const originalNames = source.getSheets().map(sheet => sheet.getName());
    if (!originalNames.length) throw backupFailure_('VERIFY_FAILED');
    const createdAt = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    const copy = source.copy('システム手帳 backup ' + createdAt.replace(/:/g, '-') + ' JST');
    stage = 'VERIFY_FAILED';
    const id = String(copy.getId() || '');
    if (!/^[A-Za-z0-9_-]+$/.test(id) || id === SPREADSHEET_ID) throw backupFailure_(stage);
    const record = { id, sourceId: SPREADSHEET_ID, createdAt, name: 'システム手帳 backup ' + createdAt + ' JST', cause, status: 'created' };
    stage = 'REGISTRY_FAILED';
    const properties = PropertiesService.getScriptProperties();
    properties.setProperty(BACKUP_COPY_PREFIX_ + id, JSON.stringify(record));
    stage = 'VERIFY_FAILED';
    if (JSON.stringify(copy.getSheets().map(sheet => sheet.getName())) !== JSON.stringify(originalNames)) throw backupFailure_(stage);
    stage = 'REGISTRY_FAILED';
    properties.setProperty(BACKUP_COPY_PREFIX_ + id, JSON.stringify(Object.assign({}, record, { status: 'verified' })));
    const next = Object.assign({}, state, { lastSuccessAt: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'), lastErrorCode: '', hasBackups: true });
    if (cause !== 'manual') next.lastDailyDate = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    stage = 'STATE_WRITE_FAILED';
    backupWriteConfig_(next);
    return next;
  } catch (_) {
    backupRecordError_(state, stage);
    throw backupFailure_(stage);
  }
}

function configureAutomaticBackups(enabled) {
  const owner = backupOwner_();
  if (typeof enabled !== 'boolean') throw new Error('バックアップの設定内容を確認できません。');
  return backupWithLock_(() => {
    let state = backupReadConfig_();
    backupReadCopies_();
    if (!enabled) {
      const trigger = backupStoredTrigger_(state);
      // Delete only the recorded trigger with our exact handler, never other jobs.
      if (trigger) {
        try { ScriptApp.deleteTrigger(trigger); }
        catch (_) { backupRecordError_(state, 'TRIGGER_SETUP_FAILED'); throw backupFailure_('TRIGGER_SETUP_FAILED'); }
      }
      backupWriteConfig_(Object.assign({}, state, { enabled: false, triggerUid: '', ownerEmail: owner, lastErrorCode: '' }));
      return backupAdminState_();
    }
    if (state.enabled && state.ownerEmail === owner && backupStoredTrigger_(state)) return backupAdminState_();
    // Verify an initial copy before claiming automatic backup is enabled.
    state = backupCopy_(Object.assign({}, state, { enabled: false, triggerUid: '', ownerEmail: owner }), 'setup');
    let created = null;
    try {
      created = ScriptApp.newTrigger(BACKUP_HANDLER_).timeBased().atHour(3).everyDays(1).inTimezone('Asia/Tokyo').create();
      const uid = String(created.getUniqueId() || '');
      if (!uid || created.getHandlerFunction() !== BACKUP_HANDLER_) throw backupFailure_('TRIGGER_SETUP_FAILED');
      backupWriteConfig_(Object.assign({}, state, { enabled: true, triggerUid: uid, ownerEmail: owner, lastErrorCode: '' }));
    } catch (_) {
      if (created && created.getHandlerFunction() === BACKUP_HANDLER_) {
        try { ScriptApp.deleteTrigger(created); } catch (_) {}
      }
      backupRecordError_(state, 'TRIGGER_SETUP_FAILED');
      throw backupFailure_('TRIGGER_SETUP_FAILED');
    }
    return backupAdminState_();
  });
}

function runBackupNow() {
  const owner = backupOwner_();
  return backupWithLock_(() => {
    const state = backupReadConfig_();
    backupReadCopies_();
    backupCopy_(Object.assign({}, state, { ownerEmail: owner }), 'manual');
    return backupAdminState_();
  });
}

// Underscore suffix prevents google.script.run callers from invoking this worker.
function systemTechoBackupDaily_(event) {
  return backupWithLock_(() => {
    const state = backupReadConfig_();
    const effective = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
    if (!state.enabled || !event || !event.triggerUid || String(event.triggerUid) !== state.triggerUid
        || !effective || effective !== state.ownerEmail || !backupStoredTrigger_(state)) return { skipped: true };
    if (state.lastDailyDate === Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd')) return { skipped: true };
    backupReadCopies_();
    backupCopy_(state, 'daily');
    return { ok: true };
  });
}
