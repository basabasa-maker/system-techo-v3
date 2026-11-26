// Read-only app status. Backup management stays on the Google owner-only page.
import { GAS_URL } from '../config.js';

export function backupAdminUrl() {
  const url = new URL(GAS_URL);
  url.searchParams.set('type', 'backup_admin');
  return url.href;
}

export async function getBackupStatus({ fetch: fetcher = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const url = new URL(GAS_URL);
  url.searchParams.set('type', 'backup_status');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url.href, { method: 'GET', mode: 'cors', redirect: 'follow', cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('バックアップの状態を確認できませんでした。');
    const body = JSON.parse(await response.text());
    const data = body?.data;
    if (body?.ok !== true || !data || typeof data.enabled !== 'boolean'
        || typeof data.hasBackups !== 'boolean'
        || !(data.lastSuccessAt == null || typeof data.lastSuccessAt === 'string')
        || !(data.lastErrorCode == null || typeof data.lastErrorCode === 'string')) {
      throw new Error('バックアップの状態を確認できませんでした。');
    }
    // Keep only public state; private copy IDs, URLs and account details stay out.
    return { enabled: data.enabled, hasBackups: data.hasBackups,
      lastSuccessAt: data.lastSuccessAt || null, lastErrorCode: data.lastErrorCode || null };
  } catch (_) {
    throw new Error('バックアップの状態を確認できませんでした。通信を確認して再確認してください。');
  } finally { clearTimeout(timer); }
}

export function backupTimeLabel(value) {
  if (!value) return 'まだありません';
  // GAS timestamps are explicitly JST, including on phones set to another timezone.
  const stamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + '+09:00' : value;
  const date = new Date(stamp);
  if (!Number.isFinite(date.getTime())) return '日時を確認できません';
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
