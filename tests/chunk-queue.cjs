const fs=require('fs');const path=require('path');const assert=require('assert/strict');const {makeBridge,backend}=require('./storage-recovery.cjs');
(async()=>{
  const dir=fs.mkdtempSync(path.join(__dirname,'../.tmp/chunk-storage/queue-'));
  const timed=makeBridge(dir);let now=1000,seq=0,firstFlush=0;const timers=new Map();
  timed.context.Date={now:()=>now};timed.context.setTimeout=(fn,ms)=>{timers.set(++seq,{fn,due:now+ms});return seq;};timed.context.clearTimeout=id=>timers.delete(id);
  timed.bridge.config.maxFlushWaitMs=100;timed.bridge.config.debounceSqliteMs=80;timed.bridge.flushSqlite=async()=>{firstFlush=now;};
  for(let i=0;i<8&&!firstFlush;i++){timed.bridge.scheduleSqliteFlush();now+=20;for(const [id,timer]of[...timers])if(timer.due<=now){timers.delete(id);timer.fn();}}
  assert.equal(firstFlush,1100);assert(timers.size<=1);
  console.log('PASS continuous updates cannot postpone autosave beyond its maximum wait');
  fs.writeFileSync(path.join(dir,'storage.json'),JSON.stringify({__updatedAt__:100,__revision__:1,data:{large:'x'.repeat(70000)}}));
  const {bridge:b}=makeBridge(dir);b.config.chunkStorage=true;await b.init();
  const store=b.customSqliteStore;let entered,release;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);let saves=0,active=0,peak=0;
  b.customSqliteStore=async(action,payload)=>{if(action==='prepareChunkSave'){saves++;active++;peak=Math.max(peak,active);if(saves===1){entered();await gate;}}const result=await store(action,payload);if(action==='prepareChunkSave')active--;return result;};
  b._setInternal('settings','first',false);const first=b.flushAll();await started;
  for(let i=0;i<100;i++)b._setInternal('settings','latest-'+i,false);
  const second=b.flushAll();release();await Promise.all([first,second]);
  assert.equal(saves,2);assert.equal(peak,1);assert.equal(backend(path.join(dir,'storage.sqlite'),'exportAll').data.settings,'latest-99');
  console.log('PASS 100 changes during an active save coalesce into one subsequent save');
  const {bridge:r}=makeBridge(dir);r.config.chunkStorage=true;await r.init();assert(!r.memory.has('large'));
  r._removeInternal('large',false);await r.flushAll();assert(!('large'in backend(path.join(dir,'storage.sqlite'),'exportAll').data));
  r._setInternal('large','x'.repeat(70000),false);await r.flushAll();
  const {bridge:clear}=makeBridge(dir);clear.config.chunkStorage=true;await clear.init();clear._removeInternal('settings',false);assert.equal(clear.memory.size,0);clear._clearInternal(false);await clear.flushAll();assert.equal(backend(path.join(dir,'storage.sqlite'),'exportMeta').totalKeys,0);
  console.log('PASS removeItem and clear operate on unloaded values in the metadata-only launcher');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
