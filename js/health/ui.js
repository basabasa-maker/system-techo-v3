import { HEALTH_METRICS } from "./model.js";
import { generateHealthKey, loadHealthSettings, saveHealthSettings } from "./bridge.js";
import { toast } from "../toast.js";

export const HEALTH_LABELS = { weight: "体重", bodyFat: "体脂肪率", kcal: "アクティブエネルギー", steps: "歩数（Apple Watch）" };
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
function dialog(title, body, footer, onClose) {
  const previous = document.activeElement;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop health-modal";
  backdrop.innerHTML = `<form class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header>${esc(title)}</header><div class="modal-body">${body}<p class="health-form-error" role="alert" hidden></p></div><footer>${footer}</footer></form>`;
  const close = () => { backdrop.remove(); onClose?.(); if (previous?.isConnected) previous.focus({preventScroll:true}); };
  backdrop.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key !== "Tab") return;
    const fields = Array.from(backdrop.querySelectorAll("button,input,a[href]")).filter(el => !el.disabled && !el.hidden && el.getClientRects().length);
    if (event.shiftKey && document.activeElement === fields[0]) { event.preventDefault(); fields.at(-1)?.focus({preventScroll:true}); }
    else if (!event.shiftKey && document.activeElement === fields.at(-1)) { event.preventDefault(); fields[0]?.focus({preventScroll:true}); }
  });
  document.body.appendChild(backdrop);
  backdrop.querySelector("form").tabIndex = -1;
  backdrop.querySelector("form").focus({preventScroll:true});
  return { element:backdrop, close, error(error) { const el=backdrop.querySelector(".health-form-error");el.textContent=error.message;el.hidden=false; } };
}
export function showHealthSettings(onSaved) {
  let settings;
  try { settings = loadHealthSettings(); } catch (error) { toast(error.message,"error");return; }
  const key = settings.pairKey || generateHealthKey();
  // Keep the first key while iPhone leaves this PWA to install the shortcut.
  // Opening settings never enables automatic reads.
  if (!settings.pairKey) {
    try { settings = saveHealthSettings({...settings,enabled:false,pairKey:key}); }
    catch (error) { toast(error.message,"error");return; }
  }
  const modal = dialog("ヘルスケア連携", `
    <p>iPhoneのショートカットで、表示中の日の4項目を読み取り、Google上の一時保管先へ送信します。初めて届いた項目は、手帳で値を確認してから連携先のGoogleスプレッドシートへ保存します。</p>
    <p class="health-small">歩数はApple Watchの記録だけを集計します。iPhoneの歩数は加えず、Watchの記録がない日は保存済みの歩数を変更しません。</p>
    <ol class="health-setup-steps"><li>下の連携キーをコピーします。</li><li><a href="shortcuts/health-bridge/system-techo-health.zip?_app_update=health-shortcut" download>追加用ZIPをダウンロード</a>します。</li><li>iPhoneの「ファイル」→「ダウンロード」でZIPをタップして展開し、中の「system-techo-health.shortcut」を開きます。</li><li>「ショートカットを設定」でキーを貼り付け、追加します。登録された名前と下のショートカット名を合わせます。</li><li>手帳で連携をONにして保存し、対象日の更新から実行します。初回の4項目の読み取り許可は順に表示されます。</li><li>読み取り後は画面左上の「システム手帳」から元のアプリへ戻り、同じ日のヘルスケア値と照合してから取り込みます。</li></ol>
    <label class="health-enable"><input type="checkbox" id="health-enabled" ${settings.enabled ? "checked" : ""}>入力画面の更新で連携する</label>
    <label>ショートカット名<input id="health-shortcut-name" value="${esc(settings.shortcutName)}" maxlength="100" /></label>
    <label>この手帳の連携キー<input type="password" id="health-pair-key" value="${esc(key)}" autocomplete="off" spellcheck="false" /></label>
    <div class="health-key-actions"><button type="button" id="health-copy-key" class="btn-ghost">キーをコピー</button><button type="button" id="health-renew-key" class="btn-ghost">キーを作り直す</button></div>
    <p class="health-small">キーを作り直した場合は、ショートカット側にも新しいキーを設定してください。</p>
    <p class="health-small">測定のない項目は変更しません。修正版はSafariを自動で開きません。元のホーム画面アプリへ戻る操作は必要です。</p>`, '<button type="button" class="btn-ghost" id="health-settings-close">キャンセル</button><button type="submit" class="btn-primary" id="health-save">保存</button>');
  modal.element.querySelector("#health-settings-close").addEventListener("click",modal.close);
  modal.element.querySelector("#health-renew-key").addEventListener("click",()=>{modal.element.querySelector("#health-pair-key").value=generateHealthKey();});
  modal.element.querySelector("#health-copy-key").addEventListener("click",async()=>{
    const input=modal.element.querySelector("#health-pair-key");
    try { await navigator.clipboard.writeText(input.value);toast("連携キーをコピーしました"); }
    catch (_) { input.type="text";input.focus({preventScroll:true});input.select();toast("キー欄を長押ししてコピーしてください"); }
  });
  modal.element.querySelector("form").addEventListener("submit",event=>{
    event.preventDefault();
    try {
      saveHealthSettings({enabled:modal.element.querySelector("#health-enabled").checked,shortcutName:modal.element.querySelector("#health-shortcut-name").value,pairKey:modal.element.querySelector("#health-pair-key").value.trim(),verifiedKeys:settings.verifiedKeys});
      modal.close();onSaved?.();toast("ヘルスケア連携の設定を保存しました");
    } catch (error) { modal.error(error); }
  });
}
export function confirmHealthValues(date, values) {
  return new Promise(resolve=>{
    let settled=false;
    const finish=value=>{if(settled)return;settled=true;modal.close();resolve(value);};
    const rows=Object.entries(values).map(([key,value])=>`<div><dt>${esc(HEALTH_LABELS[key])}</dt><dd>${esc(key === "steps" ? value : value.toFixed(1))} ${esc(key === "steps" ? "歩" : HEALTH_METRICS[key].unit)}</dd></div>`).join("");
    const modal=dialog("ヘルスケアの値を確認",`<p>${esc(date)} の値です。初めて届いた項目があるため、ヘルスケアの同じ日と一致するか確認してください。</p><dl class="health-preview">${rows}</dl><p class="health-small">測定のない項目には値を入れません。歩数はApple Watchの記録だけを使い、iPhoneの歩数は加えません。</p>`, '<button type="button" class="btn-ghost" id="health-reject">取り込まない</button><button type="submit" class="btn-primary" id="health-confirm">この値を取り込む</button>',()=>{if(!settled){settled=true;resolve(false);}});
    modal.element.querySelector("#health-reject").addEventListener("click",()=>finish(false));
    modal.element.querySelector("form").addEventListener("submit",event=>{event.preventDefault();finish(true);});
  });
}
// Observation shows the received step value without offering any record write.
export function showHealthStepObservation(date, {steps, current, receivedAt} = {}) {
  return new Promise(resolve => {
    const stepLabel = value => typeof value === "number" && Number.isInteger(value) && value >= 0 ? `${value} 歩` : "未取得";
    let timeLabel = "未取得";
    if (receivedAt !== null && receivedAt !== undefined && receivedAt !== "") {
      const time = new Date(receivedAt);
      if (Number.isFinite(time.getTime())) timeLabel = time.toLocaleString("ja-JP");
    }
    const modal = dialog("歩数を確認（保存しない）", `<p>ショートカットから届いた歩数と、手帳にある歩数です。この確認では、ヘルスケアの値を保存しません。</p>
      <dl class="health-preview">
        <div><dt>対象日</dt><dd id="health-observation-date">${esc(date)}</dd></div>
        <div><dt>受信時刻</dt><dd id="health-observation-time">${esc(timeLabel)}</dd></div>
        <div><dt>ショートカットから届いた歩数</dt><dd id="health-observation-steps" data-observation-value="steps">${esc(stepLabel(steps))}</dd></div>
        <div><dt>手帳の歩数</dt><dd id="health-observation-current" data-observation-value="current">${esc(stepLabel(current))}</dd></div>
      </dl>`, '<button type="button" class="btn-primary" id="health-step-observation-close">閉じる</button>', resolve);
    modal.element.classList.add("health-step-observation");
    modal.element.querySelector("#health-step-observation-close").addEventListener("click", modal.close);
    modal.element.querySelector("form").addEventListener("submit", event => event.preventDefault());
    modal.element.addEventListener("click", event => { if (event.target === modal.element) modal.close(); });
  });
}
export function showHealthReturnNotice() {
  const modal=dialog("元の手帳に戻ってください",'<p>この画面がSafariで開いた場合は、ホーム画面から使っているシステム手帳へ戻ると結果を受け取れます。</p><p>読み取り結果は一時保管され、表示中の日付と照合してから取り込みます。</p>', '<button type="button" class="btn-primary" id="health-return-close">閉じる</button>');
  modal.element.querySelector("#health-return-close").addEventListener("click",modal.close);
  modal.element.querySelector("form").addEventListener("submit",event=>event.preventDefault());
}
