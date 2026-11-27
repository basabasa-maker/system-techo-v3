import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as healthBridgeModule from '../js/health/bridge.js';
import assert from 'node:assert/strict';
import { createHealthBridge, saveHealthSettings, loadHealthSettings, SETTINGS_KEY, PENDING_KEY, LAST_SYNC_KEY } from '../js/health/bridge.js';
const INSPECTION_PENDING_KEY='sth_v3_health_inspection_pending';
// Actual HEAD captured before inspection support; keep the legacy reader fixed
// so the compatibility check still runs after this feature is committed.
const LEGACY_BRIDGE_REVISION='299419fe6f9fdc10ed2223c2db8844f1798a41cf';
const key='a'.repeat(43), now=1800000000000;
function fixture() {
  const map=new Map([['existing-cache',' { "keep":0 } ']]);
  const storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)};
  let time=now, serial=0, response={status:'waiting'}; const calls=[];
  const crypto={getRandomValues:array=>{array.fill(++serial);return array;}};
  const api={readHealthBridge:async body=>{calls.push(['read',body]);return response;},ackHealthBridge:async body=>{calls.push(['ack',body]);return {status:'consumed'};}};
  const bridge=createHealthBridge({storage,now:()=>time,crypto,api});
  return {bridge,storage,map,calls,setTime:t=>time=t,setResponse:r=>response=r};
}
function enable(f) { saveHealthSettings({enabled:true,shortcutName:'システム手帳 ヘルスケア同期',pairKey:key},f.storage); }
test('disabled by default; pairing settings and requests leave all existing storage intact',()=>{
  const f=fixture();assert.equal(loadHealthSettings(f.storage).enabled,false);
  assert.throws(()=>f.bridge.prepare('2026-11-25',{}));enable(f);
  assert.equal(loadHealthSettings(f.storage).pairKey,key);
  assert.equal(f.map.get('existing-cache'),' { "keep":0 } ');
});
test('launch URL contains only date and request metadata, never pairing key or health values',()=>{
  const f=fixture();enable(f);const {request,url}=f.bridge.prepare('2026-11-25',{weight:60,steps:0});
  const u=new URL(url),input=JSON.parse(u.searchParams.get('text'));
  assert.equal(u.protocol,'shortcuts:');assert.equal(u.searchParams.get('name'),'システム手帳 ヘルスケア同期');
  assert.deepEqual(Object.keys(input).sort(),['date','issued_at','request_id']);
  assert.equal(input.date,'2026-11-25');assert.equal(input.issued_at,now);assert.match(input.request_id,/^[A-Za-z0-9_-]{43}$/);
  assert(!url.includes(key));assert(!('weight' in input));assert.equal(f.bridge.pending().request_id,request.request_id);
  assert.throws(()=>f.bridge.prepare('2026-02-30',{}));
});
test('Shortcuts names use percent-encoded spaces without confusing literal plus signs',()=>{
  for(const name of ['system-techo-health 2','手帳 ヘルスケア 2','A+B & C 2']){
    const f=fixture();saveHealthSettings({enabled:true,shortcutName:name,pairKey:key},f.storage);
    const saved=f.storage.getItem(SETTINGS_KEY);
    const {url}=f.bridge.prepare('2026-11-25',{weight:60,steps:0});
    const rawName=new URL(url).search.slice(1).split('&').find(part=>part.startsWith('name=')).slice(5);
    // The native URL scheme uses percent decoding; URLSearchParams.get() would
    // hide the old bug by translating a form-encoded '+' back into a space.
    assert.equal(decodeURIComponent(rawName),name);
    assert(!rawName.includes('+'),'a space must be %20, never a form-style plus');
    if(name.includes('+'))assert(rawName.includes('%2B'),'literal plus stays a literal plus');
    assert.equal(f.storage.getItem(SETTINGS_KEY),saved,'launch does not rename or re-pair settings');
    assert.equal(f.map.get('existing-cache'),' { "keep":0 } ');assert.equal(f.calls.length,0);
  }
});
test('reads use authenticated POST metadata and accept absent metrics without fabricating zeros',async()=>{
  const f=fixture();enable(f);const {request}=f.bridge.prepare('2026-11-25',{});
  f.setResponse({status:'ready',date:request.date,issued_at:request.issued_at,values:{steps:0},units:{steps:'count'}});
  assert.deepEqual(await f.bridge.read(request),{steps:0});
  assert.deepEqual(f.calls[0][1],{request_id:request.request_id,pair_key:key,date:request.date,issued_at:request.issued_at});
  f.setResponse({status:'ready',date:request.date,issued_at:request.issued_at,values:{},units:{}});
  assert.deepEqual(await f.bridge.read(request),{});
  assert(!f.map.has(LAST_SYNC_KEY));
});
test('wrong-day results and expired requests never complete or overwrite existing state',async()=>{
  const f=fixture();enable(f);const {request}=f.bridge.prepare('2026-11-25',{weight:60});
  f.setResponse({status:'ready',date:'2026-11-24',issued_at:request.issued_at,values:{weight:70},units:{weight:'kg'}});
  await assert.rejects(f.bridge.read(request));assert(f.map.has(PENDING_KEY));
  f.setTime(now+600000);await assert.rejects(f.bridge.read(request));
  assert.equal(f.map.get('existing-cache'),' { "keep":0 } ');assert(!f.map.has(LAST_SYNC_KEY));
});
test('an older callback cannot finish a newer request, and cancel discards pending work only',async()=>{
  const f=fixture();enable(f);const first=f.bridge.prepare('2026-11-25',{}).request;
  const second=f.bridge.prepare('2026-11-26',{}).request;
  assert.equal(await f.bridge.finish(first,['weight']),false);assert.equal(f.bridge.pending().request_id,second.request_id);
  assert.equal(await f.bridge.finish(second,['steps']),true);assert.equal(f.bridge.pending(),null);
  assert.equal(JSON.parse(f.storage.getItem(LAST_SYNC_KEY)).date,'2026-11-26');
  f.bridge.prepare('2026-11-25',{});f.bridge.cancel();assert.equal(f.bridge.pending(),null);
  assert.equal(f.storage.getItem('existing-cache'),' { "keep":0 } ');
});
test('turning off or replacing pairing settings cancels previous requests',()=>{
  const f=fixture();enable(f);f.bridge.prepare('2026-11-25',{});
  saveHealthSettings({enabled:false,shortcutName:'システム手帳 ヘルスケア同期',pairKey:key},f.storage);
  assert.equal(f.bridge.pending(),null);assert(f.map.has(SETTINGS_KEY));
});

test('hand edits stay protected even if restored to their original value before the result returns',()=>{
  const f=fixture();enable(f);f.bridge.prepare('2026-11-25',{weight:60});
  assert.equal(f.bridge.markEdited('weight','2026-11-24'),false);
  assert.equal(f.bridge.markEdited('lastMeal','2026-11-25'),false);
  assert.equal(f.bridge.markEdited('weight','2026-11-25'),true);
  f.bridge.markEdited('weight','2026-11-25');
  assert.deepEqual(f.bridge.pending().editedKeys,['weight']);
});

test('first-time measurement checks are remembered per metric and reset when pairing changes',()=>{
  const f=fixture();enable(f);assert.deepEqual(loadHealthSettings(f.storage).verifiedKeys,[]);
  saveHealthSettings({...loadHealthSettings(f.storage),verifiedKeys:['weight','steps']},f.storage);
  assert.deepEqual(loadHealthSettings(f.storage).verifiedKeys,['weight','steps']);
  saveHealthSettings({...loadHealthSettings(f.storage),pairKey:'b'.repeat(43)},f.storage);
  assert.deepEqual(loadHealthSettings(f.storage).verifiedKeys,[]);
});

test('inspect mode persists only in local pending state and survives a bridge restart',()=>{
  const f=fixture();enable(f);
  const settingsRaw=f.storage.getItem(SETTINGS_KEY),previousRaw=' { "date":"2026-11-24", "keys":["steps"], "synced_at":1, "skipped":[] } ';
  f.storage.setItem(LAST_SYNC_KEY,previousRaw);
  const {request}=f.bridge.prepare('2026-11-25',{steps:4711,weight:60},{mode:'inspect'});
  assert.equal(request.mode,'inspect');assert.equal(f.bridge.pending().mode,'inspect');
  const reopened=createHealthBridge({storage:f.storage,now:()=>now,api:{}});
  assert.deepEqual(reopened.pending(),request);
  f.bridge.markEdited('steps',request.date);assert.equal(f.bridge.pending().mode,'inspect');
  assert.equal(f.storage.getItem(SETTINGS_KEY),settingsRaw);assert.equal(f.storage.getItem(LAST_SYNC_KEY),previousRaw);
  assert.equal(f.map.get('existing-cache'),' { "keep":0 } ');assert.deepEqual(f.calls,[]);
});

test('inspect launches the identical three-key Shortcut input without mode, values, or pairing key',()=>{
  const normal=fixture(),inspection=fixture();enable(normal);enable(inspection);
  const regular=normal.bridge.prepare('2026-11-25',{steps:4711,weight:60});
  const inspect=inspection.bridge.prepare('2026-11-25',{steps:4711,weight:60},{mode:'inspect'});
  assert.equal(inspect.url,regular.url,'mode must not change any launch byte');
  const url=new URL(inspect.url),input=JSON.parse(url.searchParams.get('text'));
  assert.deepEqual(Object.keys(input),['request_id','date','issued_at']);
  assert.deepEqual(input,{request_id:inspect.request.request_id,date:inspect.request.date,issued_at:inspect.request.issued_at});
  assert(!inspect.url.includes(key));assert(!('mode'in input));assert(!('steps'in input));assert(!('pair_key'in input));
  assert(!Object.hasOwn(regular.request,'mode'),'legacy pending shape remains unchanged');
});

test('inspect reads and acknowledges normally but default finish preserves raw LAST_SYNC',async()=>{
  const f=fixture();enable(f);const previousRaw=' { "date":"2026-11-24", "keys":["steps"], "synced_at":1 } ';
  f.storage.setItem(LAST_SYNC_KEY,previousRaw);
  const {request}=f.bridge.prepare('2026-11-25',{steps:100},{mode:'inspect'});
  f.setResponse({status:'ready',date:request.date,issued_at:request.issued_at,values:{steps:4711},units:{steps:'count'}});
  assert.deepEqual(await f.bridge.read(request),{steps:4711});
  assert.equal(await f.bridge.finish(request,['steps'],[]),true);
  assert.equal(f.bridge.pending(),null);assert.equal(f.storage.getItem(LAST_SYNC_KEY),previousRaw);
  assert.deepEqual(f.calls.map(call=>call[0]),['read','ack']);
  for(const [,body]of f.calls){assert.deepEqual(Object.keys(body).sort(),['date','issued_at','pair_key','request_id']);assert(!('mode'in body));}
});

test('persisted inspect mode suppresses sync history even if caller drops mode or asks to record',async()=>{
  for(const option of [{recordSync:true},{recordSync:false}]){
    const f=fixture();enable(f);const {request}=f.bridge.prepare('2026-11-25',{},{mode:'inspect'});
    const callerRequest={...request};delete callerRequest.mode;
    assert.equal(await f.bridge.finish(callerRequest,['steps'],[],option),true);
    assert.equal(f.bridge.pending(),null);assert.equal(f.storage.getItem(LAST_SYNC_KEY),null);
    assert.deepEqual(f.calls.map(call=>call[0]),['ack']);
  }
});

test('recordSync false preserves legacy history bytes while clearing pending and acknowledging',async()=>{
  const f=fixture();enable(f);const previousRaw=' { "date":"2026-11-24", "future":[0,false], "keys":["weight"] } ';
  f.storage.setItem(LAST_SYNC_KEY,previousRaw);
  const {request}=f.bridge.prepare('2026-11-25',{});
  assert.equal(await f.bridge.finish(request,['steps'],['bodyFat'],{recordSync:false}),true);
  assert.equal(f.storage.getItem(LAST_SYNC_KEY),previousRaw);assert.equal(f.bridge.pending(),null);
  assert.deepEqual(f.calls.map(call=>call[0]),['ack']);
});

test('legacy default finish still records the same sync metadata',async()=>{
  const f=fixture();enable(f);const {request}=f.bridge.prepare('2026-11-25',{});
  assert(!Object.hasOwn(f.bridge.pending(),'mode'));
  assert.equal(await f.bridge.finish(request,['steps'],['weight']),true);
  assert.deepEqual(JSON.parse(f.storage.getItem(LAST_SYNC_KEY)),{date:request.date,synced_at:now,keys:['steps'],skipped:['weight']});
  assert.equal(f.bridge.pending(),null);assert.equal(f.calls[0][0],'ack');
});

test('unknown prepare modes cannot replace pending or touch any existing storage',()=>{
  const f=fixture();enable(f);f.bridge.prepare('2026-11-25',{});const before=[...f.map];
  for(const mode of ['sync','write','',null,0,false,{},[]])assert.throws(()=>f.bridge.prepare('2026-11-25',{steps:4711},{mode}));
  assert.deepEqual([...f.map],before);assert.deepEqual(f.calls,[]);
});

test('unknown persisted modes fail closed before read or finish API calls and preserve storage',async()=>{
  for(const mode of ['sync','',null,0,false,{},[]]){
    const f=fixture();enable(f);const {request}=f.bridge.prepare('2026-11-25',{});
    f.storage.setItem(PENDING_KEY,JSON.stringify({...request,mode}));const before=[...f.map];
    assert.throws(()=>f.bridge.pending());await assert.rejects(f.bridge.read(request));await assert.rejects(f.bridge.finish(request,[],[],{recordSync:false}));
    assert.deepEqual([...f.map],before);assert.deepEqual(f.calls,[]);
  }
});

test('invalid finish options or request mode fail before acknowledging or deleting pending',async()=>{
  const f=fixture();enable(f);const {request}=f.bridge.prepare('2026-11-25',{});const before=[...f.map];
  for(const recordSync of ['false',null,0,{},[]])await assert.rejects(f.bridge.finish(request,[],[],{recordSync}));
  await assert.rejects(f.bridge.finish({...request,mode:'unknown'},[],[],{recordSync:false}));
  assert.deepEqual([...f.map],before);assert.deepEqual(f.calls,[]);
});

test('old inspect completion cannot consume a later normal request',async()=>{
  const f=fixture();enable(f);const first=f.bridge.prepare('2026-11-25',{},{mode:'inspect'}).request;
  const second=f.bridge.prepare('2026-11-25',{}).request;
  assert.equal(await f.bridge.finish(first,[],[],{recordSync:false}),false);
  assert.equal(f.bridge.pending().request_id,second.request_id);assert.equal(f.storage.getItem(LAST_SYNC_KEY),null);assert.deepEqual(f.calls,[]);
  assert.equal(await f.bridge.finish(second,['steps']),true);assert.equal(JSON.parse(f.storage.getItem(LAST_SYNC_KEY)).keys[0],'steps');
});

test('inspect uses a dedicated exported key and never writes the legacy pending slot',async()=>{
  assert.equal(healthBridgeModule.INSPECTION_PENDING_KEY,INSPECTION_PENDING_KEY);
  const f=fixture();enable(f);const writes=[],set=f.storage.setItem;
  f.storage.setItem=(name,value)=>{writes.push(name);return set(name,value);};
  const {request}=f.bridge.prepare('2026-11-25',{steps:4711},{mode:'inspect'});
  assert.equal(f.storage.getItem(PENDING_KEY),null);
  assert.equal(JSON.parse(f.storage.getItem(INSPECTION_PENDING_KEY)).mode,'inspect');
  f.bridge.markEdited('steps',request.date);
  assert.equal(f.storage.getItem(PENDING_KEY),null);
  assert.deepEqual(f.bridge.pending().editedKeys,['steps']);
  await f.bridge.finish(request,[],[],{recordSync:false});
  assert.equal(f.storage.getItem(INSPECTION_PENDING_KEY),null);assert(!writes.includes(PENDING_KEY));
});

test('inspect prepare refuses existing normal or inspection pending without replacing either',()=>{
  for(const firstMode of [undefined,'inspect']){
    const f=fixture();enable(f);f.bridge.prepare('2026-11-25',{},{mode:firstMode});const before=[...f.map];
    assert.throws(()=>f.bridge.prepare('2026-11-26',{},{mode:'inspect'}));
    assert.deepEqual([...f.map],before);assert.deepEqual(f.calls,[]);
  }
});

test('normal prepare preserves legacy superseding behavior and discards inspection metadata',()=>{
  const f=fixture();enable(f);const inspect=f.bridge.prepare('2026-11-25',{},{mode:'inspect'}).request;
  const normal=f.bridge.prepare('2026-11-25',{}).request;
  assert.notEqual(normal.request_id,inspect.request_id);assert.equal(f.storage.getItem(INSPECTION_PENDING_KEY),null);
  assert.deepEqual(JSON.parse(f.storage.getItem(PENDING_KEY)),normal);assert(!Object.hasOwn(normal,'mode'));
  const newer=f.bridge.prepare('2026-11-26',{}).request;
  assert.notEqual(newer.request_id,normal.request_id);assert.deepEqual(f.bridge.pending(),newer);
});

test('conflicting pending slots prioritize normal and cannot read or finish the hidden inspection',async()=>{
  const f=fixture();enable(f);const previousRaw=' { "date":"2026-11-24", "keys":["steps"] } ';
  f.storage.setItem(LAST_SYNC_KEY,previousRaw);
  const inspect=f.bridge.prepare('2026-11-25',{},{mode:'inspect'}).request;
  const normal={...inspect,request_id:'b'.repeat(43)};delete normal.mode;
  f.storage.setItem(PENDING_KEY,JSON.stringify(normal));const inspectRaw=f.storage.getItem(INSPECTION_PENDING_KEY);
  assert.deepEqual(f.bridge.pending(),normal);
  await assert.rejects(f.bridge.read(inspect));assert.equal(await f.bridge.finish(inspect,[],[],{recordSync:false}),false);
  assert.equal(f.storage.getItem(INSPECTION_PENDING_KEY),inspectRaw);assert.equal(f.storage.getItem(LAST_SYNC_KEY),previousRaw);assert.deepEqual(f.calls,[]);
  assert.equal(await f.bridge.finish(normal,['steps']),true);
  assert.equal(f.storage.getItem(PENDING_KEY),null);assert.equal(f.storage.getItem(INSPECTION_PENDING_KEY),null);
  assert.deepEqual(f.calls.map(call=>call[0]),['ack']);
});

test('cancel, disabling, and key replacement clear both pending slots without touching saved data',()=>{
  for(const action of ['cancel','off','key']){
    const f=fixture();enable(f);const inspect=f.bridge.prepare('2026-11-25',{},{mode:'inspect'}).request;
    const normal={...inspect,request_id:'b'.repeat(43)};delete normal.mode;
    f.storage.setItem(PENDING_KEY,JSON.stringify(normal));
    const previousRaw=' { "date":"2026-11-24", "keys":["weight"] } ';f.storage.setItem(LAST_SYNC_KEY,previousRaw);
    if(action==='cancel')f.bridge.cancel();
    else saveHealthSettings({...loadHealthSettings(f.storage),enabled:action!=='off',pairKey:action==='key'?'c'.repeat(43):key},f.storage);
    assert.equal(f.storage.getItem(PENDING_KEY),null);assert.equal(f.storage.getItem(INSPECTION_PENDING_KEY),null);
    assert.equal(f.storage.getItem(LAST_SYNC_KEY),previousRaw);assert.equal(f.map.get('existing-cache'),' { "keep":0 } ');assert.deepEqual(f.calls,[]);
  }
});

test('valid mode in the wrong storage slot fails closed instead of being treated as a normal import',async()=>{
  const f=fixture();enable(f);const inspect=f.bridge.prepare('2026-11-25',{},{mode:'inspect'}).request;
  f.storage.removeItem(INSPECTION_PENDING_KEY);f.storage.setItem(PENDING_KEY,JSON.stringify(inspect));const before=[...f.map];
  assert.throws(()=>f.bridge.pending());await assert.rejects(f.bridge.read(inspect));await assert.rejects(f.bridge.finish(inspect));
  assert.deepEqual([...f.map],before);assert.deepEqual(f.calls,[]);
  f.storage.removeItem(PENDING_KEY);const normal={...inspect};delete normal.mode;
  f.storage.setItem(INSPECTION_PENDING_KEY,JSON.stringify(normal));assert.throws(()=>f.bridge.pending());assert.deepEqual(f.calls,[]);
});

test('unknown inspection modes are rejected without deleting the inspection request',async()=>{
  for(const mode of [undefined,'normal','',null,0,false,{},[]]){
    const f=fixture();enable(f);const {request}=f.bridge.prepare('2026-11-25',{},{mode:'inspect'});
    f.storage.setItem(INSPECTION_PENDING_KEY,JSON.stringify({...request,mode}));const before=[...f.map];
    assert.throws(()=>f.bridge.pending());await assert.rejects(f.bridge.read(request));await assert.rejects(f.bridge.finish(request,[],[],{recordSync:false}));
    assert.deepEqual([...f.map],before);assert.deepEqual(f.calls,[]);
  }
});

test('actual pre-inspection bridge cannot see, read, finish or post an inspection pending request',async()=>{
  const oldSource=execFileSync('git',['show',LEGACY_BRIDGE_REVISION+':js/health/bridge.js'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8'});
  assert(!oldSource.includes('INSPECTION_PENDING_KEY'),'fixture must remain the pre-inspection bridge');
  const source=oldSource
    .replace('from "../gas-client.js"','from '+JSON.stringify(new URL('../js/gas-client.js',import.meta.url).href))
    .replace('from "./model.js"','from '+JSON.stringify(new URL('../js/health/model.js',import.meta.url).href));
  const legacy=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const f=fixture();enable(f);const previousRaw=' { "date":"2026-11-24", "keys":["steps"], "synced_at":1 } ';
  f.storage.setItem(LAST_SYNC_KEY,previousRaw);
  const {request}=f.bridge.prepare('2026-11-25',{steps:111},{mode:'inspect'}),posts=[];
  const api={readHealthBridge:async body=>{posts.push(['read',body]);return {status:'ready',date:request.date,issued_at:request.issued_at,values:{steps:4711},units:{steps:'count'}};},ackHealthBridge:async body=>{posts.push(['ack',body]);return {status:'consumed'};}};
  const old=legacy.createHealthBridge({storage:f.storage,now:()=>now,api});
  assert.equal(old.pending(),null);await assert.rejects(old.read(request));assert.equal(await old.finish(request,['steps']),false);
  assert.equal(old.markEdited('steps',request.date),false);assert.equal(f.storage.getItem(PENDING_KEY),null);
  assert.equal(f.bridge.pending().request_id,request.request_id);assert.equal(f.storage.getItem(LAST_SYNC_KEY),previousRaw);assert.deepEqual(posts,[]);
  // An old window's ordinary cancel only removes its own slot; it cannot erase
  // the separate read-only request or turn it into an ordinary import.
  old.cancel();assert.equal(old.pending(),null);assert.equal(f.bridge.pending().mode,'inspect');assert.equal(f.storage.getItem(LAST_SYNC_KEY),previousRaw);
});


test('readSnapshot preserves Watch provenance and measurement precision without changing legacy read',async()=>{
  const f=fixture();enable(f);const {request}=f.bridge.prepare('2026-11-25',{});
  f.setResponse({status:'ready',date:request.date,issued_at:request.issued_at,values:{steps:450,weight:62.34},units:{steps:'count',weight:'kg'},stepsSource:'apple_watch'});
  assert.deepEqual(await f.bridge.readSnapshot(request),{values:{steps:450,weight:62.3},stepsSource:'apple_watch'});
  assert.deepEqual(await f.bridge.read(request),{steps:450,weight:62.3});
  f.setResponse({status:'ready',date:request.date,issued_at:request.issued_at,values:{steps:900},units:{steps:'count'}});
  assert.deepEqual(await f.bridge.readSnapshot(request),{values:{steps:900}});
});
test('readSnapshot rejects malformed provenance and retains pending without writes',async()=>{
  for(const stepsSource of ['iphone','all',null,0,false,{},[]]){
    const f=fixture();enable(f);const {request}=f.bridge.prepare('2026-11-25',{});const saved=[...f.map];
    f.setResponse({status:'ready',date:request.date,issued_at:request.issued_at,values:{steps:450},units:{steps:'count'},stepsSource});
    await assert.rejects(f.bridge.readSnapshot(request));assert.deepEqual([...f.map],saved);assert(!f.map.has(LAST_SYNC_KEY));
  }
});


test('versioned response records only connection metadata and retains the configured alias',async()=>{
  const f=fixture();enable(f);saveHealthSettings({...loadHealthSettings(f.storage),shortcutName:'Existing alias 4'},f.storage);
  const {request}=f.bridge.prepare('2026-11-25',{});const previousRaw=' { "date":"2026-11-24", "keys":["steps"] } ';f.storage.setItem(LAST_SYNC_KEY,previousRaw);
  f.setResponse({status:'ready',date:request.date,issued_at:request.issued_at,values:{steps:450},units:{steps:'count'},stepsSource:'apple_watch',shortcutVersion:'1.0.0',protocolVersion:1});
  assert.deepEqual(await f.bridge.readSnapshot(request),{values:{steps:450},stepsSource:'apple_watch',shortcutVersion:'1.0.0',protocolVersion:1});
  assert.deepEqual(f.bridge.lastReceipt(),{shortcutName:'Existing alias 4',received_at:now,stepsSource:'apple_watch',shortcutVersion:'1.0.0',protocolVersion:1});
  const recorded=JSON.stringify(f.bridge.lastReceipt());assert(!recorded.includes(key));assert(!recorded.includes('450'));assert(!recorded.includes('values'));
  assert.equal(f.storage.getItem(LAST_SYNC_KEY),previousRaw);assert.equal(loadHealthSettings(f.storage).shortcutName,'Existing alias 4');
  const again=createHealthBridge({storage:f.storage,now:()=>now,api:{}});assert.deepEqual(again.lastReceipt(),f.bridge.lastReceipt());
});
test('unversioned responses remain readable and are honestly reported as version unknown',async()=>{
  const f=fixture();enable(f);const {request}=f.bridge.prepare('2026-11-25',{});
  f.setResponse({status:'ready',date:request.date,issued_at:request.issued_at,values:{steps:450},units:{steps:'count'},stepsSource:'apple_watch'});
  assert.deepEqual(await f.bridge.readSnapshot(request),{values:{steps:450},stepsSource:'apple_watch'});
  assert.equal(f.bridge.lastReceipt().shortcutVersion,null);assert.equal(f.bridge.lastReceipt().protocolVersion,null);
  saveHealthSettings({...loadHealthSettings(f.storage),shortcutName:'different alias'},f.storage);assert.equal(f.bridge.lastReceipt(),null);
});
test('malformed or incomplete release metadata is rejected without recording a receipt',async()=>{
  for(const metadata of [{shortcutVersion:'1.0.0'},{protocolVersion:1},{shortcutVersion:'1.0.0',protocolVersion:'1'},{shortcutVersion:'1.0.0',protocolVersion:2},{shortcutVersion:'bad-private-value',protocolVersion:1},{shortcutVersion:'1.0.0\n',protocolVersion:1}]){
    const f=fixture();enable(f);const {request}=f.bridge.prepare('2026-11-25',{});const before=[...f.map];
    f.setResponse({status:'ready',date:request.date,issued_at:request.issued_at,values:{},units:{},...metadata});
    await assert.rejects(f.bridge.readSnapshot(request));assert.deepEqual([...f.map],before);
  }
});
