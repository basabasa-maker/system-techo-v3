import { createAppUpdater } from './updater.js';
import { createUpdateSafety } from './safety.js';
import { THEMES, currentThemeId, selectTheme } from '../theme.js';
import { getBackupStatus, backupAdminUrl, backupTimeLabel } from '../backup/client.js';
import { getHealthSyncView, cancelHealthSync, resumeHealthAfterSettings, HEALTH_SYNC_EVENT } from '../habit.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
export function currentAppBuild() {
  return document.querySelector('meta[name="app-build"]')?.content || '';
}

export function showAppSettings({ onOpenHealthSettings, updaterOptions = {} } = {}) {
  const existing = document.querySelector('.app-settings-modal');
  if (existing) { existing.querySelector('[role="dialog"]').focus({preventScroll:true}); return; }
  const previous = document.activeElement;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(previous?.tagName || '')) previous.blur();
  const themeId = currentThemeId();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop app-settings-modal';
  backdrop.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-label="設定" tabindex="-1">
    <header>設定</header>
    <div class="modal-body app-settings-body">
      <section class="settings-section" aria-labelledby="settings-theme-title">
        <h2 id="settings-theme-title">画面の色</h2>
        <p>この端末の背景色を変更します。</p>
        <div class="theme-grid settings-theme-grid" id="settings-theme-grid" role="group" aria-labelledby="settings-theme-title">
          ${THEMES.map(t => `<button type="button" class="theme-swatch ${t.id === themeId ? 'on' : ''}" data-theme-id="${t.id}" aria-pressed="${t.id === themeId}" aria-label="${t.name}">
            <span class="theme-chip" style="background:${t.bg};color:${t.kind === 'light' ? '#22262e' : '#fff'}" aria-hidden="true">${t.id === themeId ? '✓' : ''}</span><span>${t.name}</span>
          </button>`).join('')}
        </div>
      </section>
      <section class="settings-section" aria-labelledby="settings-update-title">
        <h2 id="settings-update-title">アプリの更新</h2>
        <dl class="settings-facts"><div><dt>現在のバージョン</dt><dd id="settings-current-build">${escapeHtml(currentAppBuild() || '確認できません')}</dd></div></dl>
        <p>公開されている最新版を確認し、この画面で適用します。記録・連携設定・写真は保持します。</p>
        <button type="button" class="btn-primary settings-update-button" id="settings-apply-update">アプリを最新版に更新</button>
        <p id="settings-update-status" class="settings-update-status" role="status" aria-live="polite">未送信の記録や処理中の操作がある場合は、更新を止めてお知らせします。</p>
      </section>
      <section class="settings-section" aria-labelledby="settings-backup-title">
        <h2 id="settings-backup-title">自動バックアップ</h2>
        <p>Googleに保存済みの記録と添付画像を、スプレッドシートごとGoogleドライブへ複製します。毎日、日本時間の3時台に動作します。</p>
        <p id="settings-backup-status" class="settings-update-status" role="status" aria-live="polite">バックアップの状態を確認しています…</p>
        <button type="button" class="btn-primary settings-update-button" id="settings-open-backup">Googleでバックアップを設定</button>
        <button type="button" class="btn-ghost" id="settings-refresh-backup">状態を再確認</button>
        <p class="settings-small">管理者のGoogleアカウントで有効化・停止・保存したコピーの確認ができます。初回はGoogleの許可が必要です。管理画面から戻ると状態を確認します。</p>
        <p class="settings-small">過去のコピーは自動削除しません。この端末だけの設定・未送信の記録・外部カレンダーは対象外です。</p>
      </section>
      <section class="settings-section" aria-labelledby="settings-health-title">
        <h2 id="settings-health-title">ヘルスケア連携</h2>
        <p>体重・体脂肪率・アクティブエネルギー・歩数の設定と、連携の停止を行えます。</p>
        <p id="settings-health-status" class="settings-update-status" role="status" aria-live="polite"></p>
        <div class="settings-health-actions">
          <button type="button" class="btn-ghost" id="settings-open-health">ヘルスケア連携を設定</button>
          <button type="button" class="btn-ghost" id="settings-cancel-health" hidden>取り込みを中止</button>
        </div>
        <p class="settings-small">iPhoneに追加したショートカットは、この更新ボタンでは変更されません。修正版は連携設定の手順から追加してください。</p>
      </section>
      <section class="settings-section" aria-labelledby="settings-data-title">
        <h2 id="settings-data-title">プライバシーとデータ</h2>
        <p>記録の保存先、ヘルスケア情報の利用、連携の停止、削除の扱いを確認できます。</p>
        <a href="privacy.html" target="_blank" rel="noopener" class="settings-link">プライバシーポリシー</a>
        <a href="support.html" target="_blank" rel="noopener" class="settings-link">使い方・データ管理</a>
      </section>
      <section class="settings-section" aria-labelledby="settings-about-title">
        <h2 id="settings-about-title">アプリ情報</h2>
        <p>システム手帳</p>
        <dl class="settings-facts"><div><dt>運営者名</dt><dd id="settings-operator" aria-label="空欄"></dd></div><div><dt>問い合わせ先</dt><dd id="settings-contact" aria-label="空欄"></dd></div></dl>
      </section>
    </div>
    <footer><button type="button" class="btn-primary" id="settings-close">閉じる</button></footer>
  </section>`;
  let updating = false;
  const close = ({resumeHealth = true} = {}) => {
    if (updating) return;
    backupRequest++;
    window.removeEventListener('focus', refreshBackupOnReturn);
    document.removeEventListener('visibilitychange', refreshBackupOnReturn);
    document.removeEventListener(HEALTH_SYNC_EVENT, refreshHealthStatus);
    backdrop.remove();
    if (resumeHealth) resumeHealthAfterSettings();
    if (previous?.isConnected && !document.querySelector(".modal-backdrop")) previous.focus({preventScroll:true});
  };
  const status = backdrop.querySelector('#settings-update-status');
  const updateButton = backdrop.querySelector('#settings-apply-update');
  const closeButton = backdrop.querySelector('#settings-close');
  const healthButton = backdrop.querySelector('#settings-open-health');
  const healthCancelButton = backdrop.querySelector('#settings-cancel-health');
  const healthStatus = backdrop.querySelector('#settings-health-status');
  function refreshHealthStatus() {
    if (!backdrop.isConnected) return;
    const view = getHealthSyncView();
    healthStatus.textContent = view.message;
    healthButton.disabled = updating || view.saving;
    healthCancelButton.hidden = !view.pending;
    healthCancelButton.disabled = updating || view.saving;
  }
  const backupButton = backdrop.querySelector('#settings-open-backup');
  const backupRefreshButton = backdrop.querySelector('#settings-refresh-backup');
  const backupStatus = backdrop.querySelector('#settings-backup-status');
  let backupRequest = 0;
  let backupLoading = false;
  async function refreshBackupStatus() {
    if (updating || !backdrop.isConnected) return;
    const request = ++backupRequest;
    backupLoading = true;
    backupRefreshButton.disabled = true;
    backupStatus.classList.remove('settings-error');
    backupStatus.textContent = 'バックアップの状態を確認しています…';
    try {
      const value = await getBackupStatus();
      if (!backdrop.isConnected || request !== backupRequest) return;
      const lines = [value.enabled ? '自動バックアップ：有効（毎日・日本時間3時台）' : '自動バックアップ：停止中'];
      if (value.lastSuccessAt) lines.push('最終成功：' + backupTimeLabel(value.lastSuccessAt));
      else lines.push(value.hasBackups ? '保存したコピーがあります。最終成功日時は確認できません。' : 'バックアップはまだ作成されていません。');
      if (value.lastErrorCode) { lines.push('前回の処理は完了していません。Googleの管理画面で確認してください。'); backupStatus.classList.add('settings-error'); }
      backupStatus.textContent = lines.join(' ／ ');
    } catch (error) {
      if (!backdrop.isConnected || request !== backupRequest) return;
      backupStatus.classList.add('settings-error');
      backupStatus.textContent = error.message;
    } finally {
      if (backdrop.isConnected && request === backupRequest) {
        backupLoading = false;
        backupRefreshButton.disabled = updating;
      }
    }
  }
  function refreshBackupOnReturn() {
    if (document.visibilityState !== 'hidden' && !backupLoading) refreshBackupStatus();
  }
  function setBusy(value) {
    updating = value;
    updateButton.disabled = value;
    closeButton.disabled = value;
    refreshHealthStatus();
    backupButton.disabled = value;
    backupRefreshButton.disabled = value || backupLoading;
    backdrop.querySelectorAll('.theme-swatch').forEach(button => { button.disabled = value; });
    backdrop.querySelector('[role="dialog"]').setAttribute('aria-busy', String(value));
  }
  function progress({stage,completed,total}) {
    status.classList.remove('settings-error');
    status.textContent = ({checking:'最新版を確認しています…',verifying:`新しいファイルを確認しています…${total ? ` ${completed || 0}/${total}` : ''}`,worker:'新しい版の準備を確認しています…',reloading:'最新版へ切り替えます…'})[stage] || '更新を準備しています…';
  }
  updateButton.addEventListener('click', async () => {
    if (updating) return;
    setBusy(true);
    try {
      const prepare = createUpdateSafety();
      const updater = createAppUpdater({currentBuild:currentAppBuild(),baseUrl:document.baseURI,
        reload:()=>window.location.reload(), ...updaterOptions, beforeApply:prepare,
        onProgress:progress});
      const result = await updater.apply();
      if (result.status === 'current') status.textContent = 'このアプリは最新版です。';
    } catch (error) {
      status.classList.add('settings-error');
      status.textContent = error.message || '更新を確認できませんでした。記録はそのまま残っています。';
    } finally { setBusy(false); }
  });
  backdrop.querySelector('#settings-theme-grid').addEventListener('click', event => {
    const swatch = event.target.closest('[data-theme-id]');
    if (!swatch || updating) return;
    selectTheme(swatch.dataset.themeId);
    backdrop.querySelectorAll('[data-theme-id]').forEach(button => {
      const selected = button === swatch;
      button.classList.toggle('on', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.querySelector('.theme-chip').textContent = selected ? '✓' : '';
    });
  });
  backupButton.addEventListener('click', () => {
    if (updating) return;
    window.open(backupAdminUrl(), '_blank', 'noopener');
  });
  backupRefreshButton.addEventListener('click', refreshBackupStatus);
  closeButton.addEventListener('click', close);
  healthButton.addEventListener('click',()=>{
    if (updating || getHealthSyncView().saving) return;
    close({resumeHealth:false});onOpenHealthSettings?.();
  });
  healthCancelButton.addEventListener('click',()=>{
    if (updating || getHealthSyncView().saving) return;
    try { cancelHealthSync(); }
    catch (error) { healthStatus.textContent=error.message || '取り込みを中止できませんでした。もう一度お試しください。'; }
  });
  backdrop.addEventListener('click',event=>{if(event.target===backdrop)close();});
  backdrop.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();close();return;}
    if(event.key!=='Tab')return;
    const fields=Array.from(backdrop.querySelectorAll('button,a[href]')).filter(el=>!el.disabled&&el.getClientRects().length);
    if(!fields.length){event.preventDefault();return;}
    if(event.shiftKey&&document.activeElement===fields[0]){event.preventDefault();fields.at(-1).focus({preventScroll:true});}
    else if(!event.shiftKey&&document.activeElement===fields.at(-1)){event.preventDefault();fields[0].focus({preventScroll:true});}
  });
  document.body.appendChild(backdrop);
  document.addEventListener(HEALTH_SYNC_EVENT, refreshHealthStatus);
  refreshHealthStatus();
  backdrop.querySelector('[role="dialog"]').focus({preventScroll:true});
  window.addEventListener('focus', refreshBackupOnReturn);
  document.addEventListener('visibilitychange', refreshBackupOnReturn);
  refreshBackupStatus();
  return {close};
}
