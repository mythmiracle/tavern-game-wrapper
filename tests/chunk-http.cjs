const fs=require('fs');const path=require('path');const {spawn}=require('child_process');const assert=require('assert/strict');const {createHash}=require('crypto');
const {makeBridge,backend}=require('./storage-recovery.cjs');const {workerClient}=require('./chunk-worker.cjs');
const root=path.resolve(__dirname,'..');const hash=text=>createHash('sha256').update(text).digest('hex');
async function run(){
  const migrate=process.argv.includes('--migrate'), python=process.argv.includes('--python');
  const dir=migrate?root:fs.mkdtempSync(path.join(root,'.tmp/chunk-storage/http-'));
  if(!migrate){fs.mkdirSync(path.join(dir,'userdata'));fs.copyFileSync(path.join(root,'userdata/storage.sqlite'),path.join(dir,'userdata/storage.sqlite'));}
  const endpoint=path.join(dir,'userdata/sqlite-endpoint.json');
  if(fs.existsSync(endpoint))throw new Error('A daemon endpoint already exists; do not start a second writer');
  const processHandle=spawn(python?'python':path.join(root,'extensions/sqlite/neu-sqlite-ext.exe'),[...(python?[path.join(root,'extensions/sqlite/main.py')]:[]),'--app-root',dir],{windowsHide:true,stdio:'ignore'});
  const clients=[];let url;
  try{
    for(let i=0;i<150&&!fs.existsSync(endpoint);i++){if(processHandle.exitCode!==null)throw new Error('Daemon startup failed');await new Promise(resolve=>setTimeout(resolve,50));}
    url=JSON.parse(fs.readFileSync(endpoint,'utf8').replace(/^\uFEFF/, '')).url;
    async function rpc(action,payload={}){const response=await fetch(url+'/rpc',{method:'POST',headers:{'Content-Type':'text/plain;charset=UTF-8'},body:JSON.stringify({action,payload})});return await response.json();}
    const initial=await rpc('exportAll');assert(initial.ok);
    const baseline=Object.fromEntries(Object.entries(initial.data).map(([key,value])=>[key,hash(value)]));
    const info={sourceKeys:Object.keys(baseline).length,sourceBytes:Buffer.byteLength(initial.data['tavern-game']),totalValueBytes:Object.values(initial.data).reduce((n,text)=>n+Buffer.byteLength(text),0),scenarios:{}};
    if(!migrate){
      let baseId=initial.saveCommit.id;const samples=[];
      const legacy=async(data,all=false)=>{
        const values=all?data:{'tavern-game':data['tavern-game']};
        const payload={id:crypto.randomUUID(),baseId,revision:1,updatedAt:Date.now(),legacyUpdatedAt:initial.saveCommit.legacyUpdatedAt,clearAll:all,kvDeletes:[],kvUpserts:Object.entries(values).map(([key,valueText])=>({key,valueText})),expectedHashes:Object.fromEntries(Object.entries(data).map(([k,v])=>[k,hash(v)]))};
        const start=performance.now();const result=await rpc('commitSave',payload);assert(result.ok,result.error);baseId=result.commit.id;return performance.now()-start;
      };
      if(initial.saveCommit.format===22)await legacy(initial.data,true);
      for(let i=0;i<5;i++)samples.push(await legacy({...initial.data,'tavern-game':initial.data['tavern-game']+' '.repeat(i+1)}));
      await legacy(initial.data);samples.sort((a,b)=>a-b);info.legacySaveMs={samples,p50:samples[2],p95:samples[4],trials:5};
    }
    const make=()=>{const pair=makeBridge(path.join(dir,'userdata'));const b=pair.bridge;b.config.chunkStorage=true;b.customSqliteStore=null;b.sqliteEndpointUrl=url;b.sqliteConnected=true;b.ensureSqliteExtensionInstalledAndRunning=async()=>true;b._chunkWorkerClient=workerClient();clients.push(b._chunkWorkerClient);return pair;};
    const {bridge:b}=make();const conversionStart=performance.now();await b.init();info.conversionMs=performance.now()-conversionStart;
    const converted=await rpc('exportAll');assert(converted.ok);assert.equal(converted.saveCommit.format,22);
    assert.deepEqual(Object.fromEntries(Object.entries(converted.data).map(([key,value])=>[key,hash(value)])),baseline);
    const {bridge:reader}=make();const listStart=performance.now();await reader.init();info.launcherMetadataMs=performance.now()-listStart;assert(reader._metadataOnly);assert(!reader.memory.has('tavern-game'));
    if(!migrate){
      await b.ensureDataLoaded();
      b._setInternal('__chunk_benchmark_setting','small',false);await b.flushAll();info.scenarios.smallSetting=b.chunkMetrics;assert.equal(b.chunkMetrics.scannedBytes,5);assert.equal(b.chunkMetrics.uploadedBytes,0);
      const original=b.memory.get('tavern-game');const match=/"day"\s*:\s*(\d+)/.exec(original);assert(match);
      const index=match.index+match[0].length-1;const edited=original.slice(0,index)+String((Number(original[index])+1)%10)+original.slice(index+1);
      const chunkTimes=[];
      for(let i=0;i<5;i++){const edit=original.slice(0,index)+String((Number(original[index])+i+1)%10)+original.slice(index+1);b._setInternal('tavern-game',edit,false);await b.flushAll();chunkTimes.push(b.chunkMetrics.totalMs);if(i===0)info.scenarios.smallGameEdit={...b.chunkMetrics};}
      chunkTimes.sort((a,b)=>a-b);info.chunkSaveMs={samples:chunkTimes,p50:chunkTimes[2],p95:chunkTimes[4],trials:5};
      b._setInternal('tavern-game',edited,false);await b.flushAll();info.scenarios.revisitedState=b.chunkMetrics;assert(b.chunkMetrics.uploadedBytes<info.sourceBytes*.1);
      b._setInternal('tavern-game','\n'+edited,false);await b.flushAll();info.scenarios.prefixInsertion=b.chunkMetrics;assert(b.chunkMetrics.uploadedBytes<info.sourceBytes*.1);
      const {bridge:cold,globalStub}=make();globalStub.__IS_WAYWARD_LAUNCHER_UI__=false;const coldStart=performance.now();await cold.init();info.gameRestoreMs=performance.now()-coldStart;assert.equal(hash(cold.memory.get('tavern-game')),hash('\n'+edited));
      console.log('PASS native HTTP binary chunks, real Worker, metadata-only launcher, exact game restore and >90% transfer reduction');
    }
    info.commitId=(await rpc('exportMeta')).saveCommit.id;
    await rpc('shutdown',{deleteBinary:false,killParent:false});if(processHandle.exitCode===null)await new Promise(resolve=>processHandle.once('exit',resolve));
    if(migrate){
      const reopened=backend(path.join(dir,'userdata/storage.sqlite'),'exportAll');assert(reopened.ok);assert.equal(reopened.saveCommit.id,info.commitId);
      assert.deepEqual(Object.fromEntries(Object.entries(reopened.data).map(([key,value])=>[key,hash(value)])),baseline);
      info.verification={matchedKeys:Object.keys(baseline).length,reopened:true,sourceCommitId:initial.saveCommit.id,valuesSha256:baseline};
      console.log('PASS actual save converted to v22, daemon stopped and all reopened SHA-256 values match');
    }
    fs.writeFileSync(path.join(root,'.tmp/chunk-storage',migrate?'migration.json':python?'benchmark-python.json':'benchmark.json'),JSON.stringify(info,null,2));
    const {verification,...summary}=info;console.log(JSON.stringify({...summary,...(verification?{verifiedKeys:verification.matchedKeys,reopened:verification.reopened}:{})}));
  }finally{for(const client of clients)await client.dispose();if(processHandle.exitCode===null)processHandle.kill();}
}
run().catch(e=>{console.error(e.stack);process.exitCode=1;});
