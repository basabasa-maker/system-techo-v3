import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthBridge, saveHealthSettings, loadHealthSettings, SETTINGS_KEY, PENDING_KEY, LAST_SYNC_KEY } from '../js/health/bridge.js';
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
