// Routing and editor authorization only; no Google services or record access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../gas/Code.gs'), 'utf8');
function fixture() {
  const calls = [];
  const context = vm.createContext({
    getBackupStatus() { calls.push('status'); return {enabled:false,hasBackups:false,lastSuccessAt:'',lastErrorCode:''}; },
    renderBackupAdminPage() { calls.push('admin'); return {html:true}; },
    configureAutomaticBackups() { throw new Error('REST must not configure'); },
    runBackupNow() { throw new Error('REST must not copy'); },
    backupOwner_() { calls.push('owner'); },
    ScriptApp: {AuthMode:{FULL:'FULL'}, requireScopes(mode, scopes) {calls.push({mode,scopes:[...scopes]});},getProjectTriggers(){calls.push('triggers');return [];}},
    ContentService: {MimeType:{JSON:'json'},createTextOutput(text){return {text,setMimeType(){return this;}};}},
  });
  vm.runInContext(source, context);
  return {context,calls};
}
test('GET routes read-only public status and owner HTML directly', () => {
  const h=fixture();
  const status=JSON.parse(h.context.doGet({parameter:{type:'backup_status'}}).text);
  assert.equal(status.ok,true);assert.equal(status.data.enabled,false);
  assert.deepEqual(h.context.doGet({parameter:{type:'backup_admin'}}),{html:true});
  assert.deepEqual(h.calls,['status','admin']);
});
test('REST parameters cannot configure, copy, delete or restore backups', () => {
  for (const type of ['configureAutomaticBackups','runBackupNow','backup_enable','backup_restore','backup_delete']) {
    const h=fixture();
    assert.equal(JSON.parse(h.context.doGet({parameter:{type,enabled:'true'}}).text).ok,false);
    assert.equal(JSON.parse(h.context.doPost({postData:{contents:JSON.stringify({type,enabled:true})}}).text).ok,false);
    assert.deepEqual(h.calls,[]);
  }
});
test('editor authorization check requests trigger scope without data copies or trigger creation', () => {
  const h=fixture();
  assert.equal(h.context.authorizeBackupSetup_().authorized,true);
  assert.deepEqual(h.calls,[{mode:'FULL',scopes:['https://www.googleapis.com/auth/script.scriptapp']},'owner','triggers']);
  const manifest=JSON.parse(fs.readFileSync(require('node:path').join(__dirname,'../gas/appsscript.json'),'utf8'));
  assert(manifest.oauthScopes.includes('https://www.googleapis.com/auth/script.scriptapp'));
  assert(!manifest.oauthScopes.includes('https://www.googleapis.com/auth/drive'));
});
