const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { createStorageChunkCodec } = require('../storage-chunks.js');
const { makeBridge, backend } = require('./storage-recovery.cjs');
const codec = createStorageChunkCodec();
function text(size) { let seed = 1234567, parts = [], chunk = ''; for (let i=0;i<size;i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; chunk += String.fromCharCode(32 + ((seed >>> 0) % 90)); if (chunk.length === 8192) { parts.push(chunk); chunk=''; } } parts.push(chunk); return parts.join(''); }
function join(result) { return Buffer.concat(result.manifest.chunks.map(c=>result.buffers.get(c.hash))); }
async function test() {
  for (const value of ['', '한글😀', '한글😀'.repeat(40000), 'x\ud800y', 'x\udfffy', '\ufeffBOM', '\ufeff'+'한글😀'.repeat(40000), 'A'.repeat(70000)]) {
    const result = await codec.encode(value);
    const bytes = result.manifest.inline !== undefined ? Buffer.from(value) : join(result);
    assert.equal(await codec.decode(bytes, result.manifest), value);
    assert(result.manifest.chunks.every(c=>c.bytes <= 524288));
  }
  console.log('PASS lossless empty/Unicode/isolated-surrogate/chunk-boundary roundtrips');
  const vectorDir=fs.mkdtempSync(path.join(__dirname,'../.tmp/chunk-storage/vectors-')),vectorDb=path.join(vectorDir,'storage.sqlite');let prior='';
  const vectors=JSON.parse(fs.readFileSync(path.join(__dirname,'../.tmp/chunk-storage/vectors.json'),'utf8'));
  for(let i=0;i<vectors.length;i++){
    const vector=vectors[i],payload={id:'vector-'+i,baseId:prior,revision:i,updatedAt:100,legacyUpdatedAt:90,entries:{game:vector.manifest.root},manifests:[vector.manifest]};
    payload.rootHash=await codec.snapshotRoot(payload);
    const prepared=backend(vectorDb,'prepareChunkSave',payload);assert(prepared.ok,prepared.error);
    for(const hash of prepared.missing){const packed=codec.pack([{hash,bytes:Buffer.from(vector.chunks[hash],'base64')}]);assert(backend(vectorDb,'putChunkBatch',{id:payload.id,bytes:Array.from(packed)}).ok);}
    const committed=backend(vectorDb,'commitChunkSave',{id:payload.id});assert(committed.ok,committed.error);
    const restored=backend(vectorDb,'exportAll');assert(restored.ok,restored.error);assert(Buffer.from(restored.data.game,'utf16le').equals(Buffer.from(vector.value,'utf16le')));
    prior=payload.id;
  }
  console.log('PASS shared C#/Python vectors include UTF-8 characters split across chunks and isolated UTF-16 surrogates');
  const original = text(4*1024*1024), first = await codec.encode(original);
  for (const changed of [original+'new event', 'prefix'+original, original.slice(1024), original.slice(0,1000000)+'changed'+original.slice(1000007)]) {
    const encoded = await codec.encode(changed);
    const newBytes = [...encoded.buffers].filter(([h])=>!first.buffers.has(h)).reduce((n,[h,b])=>n+b.length,0);
    assert(newBytes < original.length * .25, 'CDC resynchronizes after edits rather than shifting every chunk');
  }
  console.log('PASS content-defined chunks resynchronize after append, prefix insertion, front deletion and middle edits');
  const dir = fs.mkdtempSync(path.join(__dirname,'../.tmp/chunk-storage/test-'));
  const db = path.join(dir,'storage.sqlite');
  fs.writeFileSync(path.join(dir,'storage.json'),JSON.stringify({__updatedAt__:100,__revision__:1,data:{settings:'old'},__external__:{game:'blob_test.dat'}}));
  fs.writeFileSync(path.join(dir,'blob_test.dat'),original);
  const {bridge:b}=makeBridge(dir); await b.init();
  b.config.chunkStorage=true;
  await b.flushAll();
  assert.equal(b._verifiedSqliteCommit.format,22);
  assert.equal(backend(db,'exportAll').data.game,original);
  console.log('PASS v21-to-v22 conversion verifies and reopens the original content');
  const {bridge:lazy}=makeBridge(dir); lazy.config.chunkStorage=true;
  lazy.hashStorageValues=()=>{throw new Error('Unexpected whole-save hash');};
  await lazy.init();
  assert(lazy._metadataOnly); assert(!lazy.memory.has('game')); assert.equal(lazy.getStats().totalKeys,2);
  Object.getPrototypeOf(lazy).installProxy.call(lazy);
  assert.equal(lazy.proxy.length,2);assert('game' in lazy.proxy);assert.equal(lazy.proxy.settings,'old');
  assert.deepEqual(Array.from(Reflect.ownKeys(lazy.proxy)).sort(),['game','settings']);assert(!lazy.memory.has('game'));
  lazy._setInternal('settings','new',false); await lazy.flushAll();
  assert.equal(lazy.chunkMetrics.uploadedBytes,0); assert.equal(lazy.chunkMetrics.scannedBytes,3);
  assert.equal(backend(db,'exportAll').data.game,original);
  await lazy.ensureDataLoaded(); assert.equal(lazy.memory.get('game'),original);
  assert.equal(lazy.proxy.getItem('game'),original);assert.equal(lazy.proxy.getItem('missing'),null);
  console.log('PASS metadata-only launcher, zero large-value work on settings save and explicit full restore');
  const fakeWindow={name:'',location:{pathname:'/game.html',reload(){fakeWindow.reloaded=true;}}};
  const cold=makeBridge(dir,{window:fakeWindow,syncGet:url=>url.endsWith('storage.json')?JSON.stringify({__updatedAt__:100,__revision__:1,data:{game:'STALE'}}):null});
  cold.globalStub.__IS_WAYWARD_LAUNCHER_UI__=false;cold.bridge.config.chunkStorage=true;cold.bridge.restoreSnapshotFromWindowName=()=>false;
  assert(cold.bridge.bootstrapSyncIfPossible());cold.bridge._setInternal('game','stale game would overwrite',false);await cold.bridge.init();
  assert(fakeWindow.reloaded);assert.equal(cold.bridge.memory.get('game'),original);assert.equal(backend(db,'exportAll').data.game,original);
  assert.throws(()=>cold.bridge._setInternal('game','late stale timer',false),/다시 불러오는 중/);
  assert.throws(()=>cold.bridge._removeInternal('game',false),/다시 불러오는 중/);
  assert.throws(()=>cold.bridge._clearInternal(false),/다시 불러오는 중/);
  console.log('PASS cold bootstrap from stale legacy data reloads the latest committed state before saving');
  const before=backend(db,'exportMeta');
  const change=await codec.encode(original+'append');
  const entries={...before.saveCommit.hashes,game:change.manifest.root};
  const pending={id:'interrupted',baseId:before.saveCommit.id,revision:3,updatedAt:300,legacyUpdatedAt:100,entries,manifests:[change.manifest]};
  pending.rootHash=await codec.snapshotRoot(pending);
  const prepared=backend(db,'prepareChunkSave',pending);assert(prepared.ok);
  assert.equal(backend(db,'commitChunkSave',{id:pending.id}).ok,false);
  assert.equal(backend(db,'exportMeta').saveCommit.id,before.saveCommit.id);
  const hash=prepared.missing[0],batch=codec.pack([{hash,bytes:change.buffers.get(hash)}]);
  const broken=Uint8Array.from(batch);broken[broken.length-1]^=1;
  assert.equal(backend(db,'putChunkBatch',{id:pending.id,bytes:Array.from(broken)}).ok,false);
  for(const h of prepared.missing) assert(backend(db,'putChunkBatch',{id:pending.id,bytes:Array.from(codec.pack([{hash:h,bytes:change.buffers.get(h)}]))}).ok);
  assert(backend(db,'collectChunks').ok);
  assert(backend(db,'commitChunkSave',{id:pending.id}).ok);
  assert.equal(backend(db,'exportAll').data.game,original+'append');
  assert(backend(db,'commitChunkSave',{id:pending.id}).ok);
  console.log('PASS missing/corrupt uploads preserve the prior save; staged chunks survive GC; activation is idempotent');
  const {bridge:latest}=makeBridge(dir);latest.config.chunkStorage=true;await latest.init();await latest.ensureDataLoaded();
  latest._setInternal('settings','reply lost',false);
  const store=latest.customSqliteStore;
  latest.customSqliteStore=async(action,payload)=>{const result=await store(action,payload);return action==='commitChunkSave'?null:result;};
  await latest.flushAll();assert.equal(latest.dirtySqliteKeys.size,0);latest.customSqliteStore=store;
  latest.config.chunkStorage=false;await latest.flushAll();
  const legacy=backend(db,'exportAll');assert.notEqual(legacy.saveCommit.format,22);assert.equal(legacy.data.game,original+'append');assert.equal(legacy.data.settings,'reply lost');
  console.log('PASS lost acknowledgement recovery and rollback preserve the latest progress');
  latest.config.chunkStorage=true;await latest.flushAll();latest._clearInternal(false);await latest.flushAll();
  const {bridge:empty}=makeBridge(dir);empty.config.chunkStorage=true;await empty.init();assert.equal(empty.getStats().totalKeys,0);
  assert(fs.existsSync(path.join(dir,'blob_test.dat')));
  console.log('PASS atomic clear does not resurrect retained legacy data');
  console.log('ALL CHUNK STORAGE TESTS PASSED');
}
if(require.main===module)test().catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={text};
