const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Pure local GAS stubs and synthetic fetch only; never calls Google services.
const root=require('node:path').resolve(__dirname,'..');
const sheets=new Map(),touches=[],locks={active:false,acquired:0,released:0};
class Range{
 constructor(sheet,row,col,rows=1,cols=1){Object.assign(this,{sheet,row,col,rows,cols});}
 getValues(){return Array.from({length:this.rows},(_,r)=>Array.from({length:this.cols},(_,c)=>this.sheet.rows[this.row-1+r]?.[this.col-1+c]??''));}
 setValues(values){for(let r=0;r<this.rows;r++){const target=this.sheet.rows[this.row-1+r]||=[];for(let c=0;c<this.cols;c++)target[this.col-1+c]=values[r][c];}return this;}
 setNumberFormat(){return this;}
}
class Sheet{
 constructor(name,rows=[]){this.name=name;this.rows=structuredClone(rows);}
 getRange(...args){return new Range(this,...args);}
 getMaxRows(){return Math.max(100,this.rows.length);}
 getLastRow(){return this.rows.length;}
 getLastColumn(){return Math.max(0,...this.rows.map(row=>row.length));}
 appendRow(row){this.rows.push([...row]);return this;}
}
for(const name of ['tasks','memo','habit_days','habit_items','meals','メモ添付'])sheets.set(name,new Sheet(name,[['old','headers'],['untouched',name,0,false,'既存データ']]));
const old=JSON.stringify([...sheets].map(([name,sheet])=>[name,sheet.rows]));
const ss={getSheetByName(name){touches.push(name);return sheets.get(name)||null;},insertSheet(name){const sheet=new Sheet(name);sheets.set(name,sheet);return sheet;}};
const context={console,SpreadsheetApp:{openById(){return ss;}},Utilities:{formatDate(){return '2026-11-24 22:15';},getUuid(){return 'test-uuid';}},LockService:{getScriptLock(){return {waitLock(){assert.equal(locks.active,false);locks.active=true;locks.acquired++;},releaseLock(){assert.equal(locks.active,true);locks.active=false;locks.released++;}};}},ContentService:{MimeType:{JSON:'application/json'},createTextOutput(text){return {text,setMimeType(){return this;}};}}};
vm.createContext(context);vm.runInContext(fs.readFileSync(root+'/gas/Code.gs','utf8'),context);
const get=()=>JSON.parse(context.doGet({parameter:{type:'goals'}}).text);
const post=(type,key,payload)=>JSON.parse(context.doPost({postData:{contents:JSON.stringify({type,[key]:payload})}}).text);
const node=payload=>post('goal_node_upsert','node',payload);
const board=payload=>post('goal_board_upsert','board',payload);
const item=payload=>post('goal_item_upsert','item',payload);
function ok(response){assert.equal(response.ok,true,response.error);return response.data;}
function bad(response){assert.equal(response.ok,false);assert.equal(typeof response.error,'string');assert.equal(locks.active,false);}
let tests=0;function test(name,fn){fn();tests++;console.log('PASS',name);}
(async()=>{
test('new GET creates only isolated goal sheets, keeps existing content',()=>{
 assert.deepEqual(ok(get()),{nodes:[],boards:[],items:[]});
 assert.deepEqual([...sheets.keys()].filter(name=>name.startsWith('goal_')).sort(),['goal_board_items','goal_boards','goal_nodes']);
 for(const name of ['goal_nodes','goal_boards','goal_board_items'])assert.deepEqual(sheets.get(name).rows[0],['id','json','updated_at']);
 assert(touches.every(name=>name.startsWith('goal_')));
});
test('hierarchy validates parent existence, type, title, cycles, and immutable kind',()=>{
 bad(node({id:'early',kind:'goal',parent_id:'missing',title:'親がない'}));
 bad(node({id:'invalid',kind:'other',title:'誤種別'}));bad(node({id:'empty',kind:'purpose',title:'  '}));
 const purpose=ok(node({id:'p1',kind:'purpose',title:'目的',future:{nested:[0,false,'保全']}}));
 assert.equal(purpose.parent_id,'');assert.equal(purpose.deleted,0);
 ok(node({id:'g1',kind:'goal',parent_id:'p1',title:'目標',sort_order:0}));
 ok(node({id:'m1',kind:'means',parent_id:'g1',title:'手段'}));
 bad(node({id:'wrong-parent',kind:'goal',parent_id:'m1',title:'親種別不正'}));
 bad(node({id:'p1',parent_id:'m1'}));bad(node({id:'g1',kind:'purpose',parent_id:''}));
 assert(!ok(get()).nodes.some(row=>row.id==='early'||row.id==='wrong-parent'));
});
test('partial node updates retain unknown fields, creation date, and explicit zero',()=>{
 const before=ok(get()).nodes.find(row=>row.id==='p1');
 const after=ok(node({id:'p1',description:'説明だけ更新',sort_order:0}));
 assert.deepEqual(after.future,before.future);assert.equal(after.title,'目的');assert.equal(after.created_at,before.created_at);
 assert.equal(after.updated_at,'2026-11-24 22:15');assert.equal(after.sort_order,0);
});
test('parent deletion is rejected until live children are removed; tombstones remain',()=>{
 bad(node({id:'p1',deleted:1}));bad(node({id:'g1',deleted:1}));
 ok(node({id:'m1',deleted:1}));ok(node({id:'g1',deleted:1}));
 const rows=ok(get()).nodes;assert.equal(rows.find(row=>row.id==='m1').deleted,1);assert.equal(rows.find(row=>row.id==='g1').deleted,1);
 assert.equal(rows.find(row=>row.id==='p1').deleted,0);
});
test('board defaults and future background settings are preserved by partial updates',()=>{
 const first=ok(board({id:'vision-main',title:'ビジョンボード',future_layout:{snap:false}}));
 assert.equal(first.width,1200);assert.equal(first.height,1600);assert.equal(first.background,'cork');
 const background={type:'image',assetId:'asset-background',tileScale:1.25,future:false};
 ok(board({id:'vision-main',background}));
 const after=ok(board({id:'vision-main',title:'名前だけ'}));
 assert.deepEqual(after.background,background);assert.deepEqual(after.future_layout,{snap:false});
 bad(board({id:'vision-main',width:0}));bad(board({id:'vision-main',height:100001}));
});
test('items validate references and finite numeric bounds, preserve unknown fields',()=>{
 ok(node({id:'g2',kind:'goal',parent_id:'p1',title:'写真の目標'}));
 bad(item({id:'missing-board',board_id:'missing',attachment_id:'image',goal_id:'g2'}));
 bad(item({id:'bad-link',board_id:'vision-main',attachment_id:'image',goal_id:'p1'}));
 bad(item({id:'bad-x',board_id:'vision-main',attachment_id:'image',x:1e8}));
 bad(item({id:'bad-number',board_id:'vision-main',attachment_id:'image',width:null}));
 bad(item({id:'bad-angle',board_id:'vision-main',attachment_id:'image',rotation:361}));
 const first=ok(item({id:'i1',board_id:'vision-main',attachment_id:'image',name:'画像.jpg',mime:'image/jpeg',goal_id:'g2',x:0,y:-10,rotation:0,z_index:0,future_crop:{left:0}}));
 assert.equal(first.width,220);assert.equal(first.height,180);
 const after=ok(item({id:'i1',caption:'説明だけ',x:15}));
 assert.equal(after.attachment_id,'image');assert.equal(after.y,-10);assert.equal(after.goal_id,'g2');assert.deepEqual(after.future_crop,{left:0});
});
test('cover references require a live item linked to the same goal',()=>{
 const covered=ok(node({id:'g2',cover_item_id:'i1'}));assert.equal(covered.cover_item_id,'i1');
 bad(node({id:'g2',cover_item_id:'missing-item'}));
 ok(node({id:'g3',kind:'goal',parent_id:'p1',title:'別の目標'}));
 bad(node({id:'g3',cover_item_id:'i1'}));bad(item({id:'i1',goal_id:'g3'}));
});
test('logical deletes never erase boards, images, or unrelated goal records',()=>{
 ok(node({id:'g2',deleted:1}));
 const afterGoal=ok(get());assert.equal(afterGoal.items.find(row=>row.id==='i1').deleted,0);
 assert.equal(afterGoal.items.find(row=>row.id==='i1').goal_id,'g2');
 ok(item({id:'i1',caption:'参照先が消えても説明は編集可能'}));
 ok(board({id:'vision-main',deleted:1}));assert.equal(ok(get()).items.find(row=>row.id==='i1').deleted,0);
 ok(item({id:'i1',deleted:1}));assert.equal(ok(get()).items.find(row=>row.id==='i1').deleted,1);
});
test('new endpoints never touch or rewrite any pre-existing sheet',()=>{
 assert.equal(JSON.stringify([...sheets].filter(([name])=>!name.startsWith('goal_')).map(([name,sheet])=>[name,sheet.rows])),old);
 assert(touches.every(name=>name.startsWith('goal_')));
 assert.equal(locks.active,false);assert.equal(locks.acquired,locks.released);
 const meta=JSON.parse(context.doGet({parameter:{type:'meta'}}).text);assert.equal(meta.data.schema_version,2);assert.equal(meta.data.calendar_count,9);
});
// Exercise the actual sync dispatcher and actual client wrappers against GAS's
// public doPost handler. Only transport and IndexedDB removal are substituted.
{
 const originalFetch=global.fetch,calls=[],removed=[];
 const purpose={id:'contract-purpose',kind:'purpose',parent_id:'',title:'依存順の目的',future_flag:false};
 const goal={id:'contract-goal',kind:'goal',parent_id:purpose.id,title:'写真付き目標',cover_item_id:'',description:'同じ画像をカードとボードで使う'};
 const vision={id:'contract-board',title:'依存順ボード',background:'cork',width:1200,height:1600};
 const image={id:'contract-item',board_id:vision.id,attachment_id:'contract-attachment',name:'目標.jpg',mime:'image/jpeg',goal_id:goal.id,x:0,y:15,width:280,height:220,rotation:-5,z_index:0,caption:'目標と共有する写真'};
 const rows=[
   {id:21,op:{type:'goal_node_upsert',payload:purpose}},
   {id:22,op:{type:'goal_node_upsert',payload:goal}},
   {id:23,op:{type:'goal_board_upsert',payload:vision}},
   {id:24,op:{type:'goal_item_upsert',payload:image}},
   {id:25,op:{type:'goal_node_upsert',payload:{...goal,cover_item_id:image.id}}},
 ];
 try{
   global.fetch=async(url,options)=>{
     assert.equal(options.method,'POST');
     assert.equal(options.headers['Content-Type'],'text/plain;charset=utf-8');
     const payload=JSON.parse(options.body);
     const response=context.doPost({postData:{contents:options.body}});
     calls.push({payload,response:JSON.parse(response.text)});
     return {ok:true,text:async()=>response.text};
   };
   const {flushGoalOperations}=await import(require('node:url').pathToFileURL(root+'/js/sync.js').href);
   const failed=await flushGoalOperations([...rows].reverse(),{removeOperation:async id=>{removed.push(id);}});
   assert.equal(failed,0,'real server validation must accept every dependency in its original queue order');
   assert.equal(calls.length,5,'initial goal must remain separate from its later cover update');
   assert.deepEqual(removed,[21,22,23,24,25]);
   assert.deepEqual(calls.map(call=>call.payload.type),rows.map(row=>row.op.type));
   const entityKeys=['node','node','board','item','node'];
   calls.forEach((call,index)=>{
     assert.deepEqual(Object.keys(call.payload).sort(),['type',entityKeys[index]].sort(),'wrapper must send the named entity');
     assert.deepEqual(call.payload[entityKeys[index]],rows[index].op.payload);
     assert.equal(call.response.ok,true,call.response.error);
   });
   const persisted=ok(get());
   assert.equal(persisted.nodes.find(row=>row.id===goal.id).cover_item_id,image.id);
   assert.equal(persisted.nodes.find(row=>row.id===purpose.id).future_flag,false);
   assert.equal(persisted.items.find(row=>row.id===image.id).goal_id,goal.id);
   assert.equal(persisted.items.find(row=>row.id===image.id).board_id,vision.id);
   assert.equal(JSON.stringify([...sheets].filter(([name])=>!name.startsWith('goal_')).map(([name,sheet])=>[name,sheet.rows])),old);
   assert.equal(locks.active,false);assert.equal(locks.acquired,locks.released);
   tests++;console.log('PASS real sync -> client wrappers -> GAS public handlers preserve purpose/goal/board/item/cover order');
 }finally{global.fetch=originalFetch;}
}
test('corrupt goal JSON fails visibly instead of returning an empty authoritative list',()=>{
 sheets.get('goal_board_items').rows.push(['corrupt','not json','2026-11-24 22:15']);bad(get());
});
const originalFetch=global.fetch;const calls=[];
try{
 global.fetch=async(url,options)=>{calls.push({url:String(url),options});return {ok:true,text:async()=>JSON.stringify({ok:true,data:options.method==='GET'?{nodes:[{id:'n'}],boards:[],items:[]}:{saved:true}})};};
 const source=fs.readFileSync(root+'/js/gas-client.js','utf8').replace('import { GAS_URL } from "./config.js";','const GAS_URL="https://synthetic.invalid/exec";');
 const client=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 assert.deepEqual(await client.pullGoals(),{nodes:[{id:'n'}],boards:[],items:[]});
 assert.deepEqual(await client.pushGoalNode({id:'n',title:'目標'}),{saved:true});
 await client.pushGoalBoard({id:'b'});await client.pushGoalItem({id:'i'});
 assert.equal(new URL(calls[0].url).searchParams.get('type'),'goals');assert.equal(calls[0].options.method,'GET');
 assert.deepEqual(calls.slice(1).map(call=>JSON.parse(call.options.body)),[{type:'goal_node_upsert',node:{id:'n',title:'目標'}},{type:'goal_board_upsert',board:{id:'b'}},{type:'goal_item_upsert',item:{id:'i'}}]);
 assert(calls.slice(1).every(call=>call.options.headers['Content-Type']==='text/plain;charset=utf-8'));
 global.fetch=async()=>({ok:true,text:async()=>JSON.stringify({ok:false,error:'synthetic failure'})});
 await assert.rejects(client.pullGoals(),/synthetic failure/);await assert.rejects(client.pushGoalItem({id:'i'}),/synthetic failure/);
 tests++;console.log('PASS API client request/response contracts and errors');
}finally{global.fetch=originalFetch;}
console.log('PASS '+tests+' goal backend/client groups; no real services called');
})().catch(error=>{console.error(error);process.exitCode=1;});
