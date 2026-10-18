const fs=require('fs');const {createStorageChunkCodec}=require('../storage-chunks.js');
(async()=>{
  const manifest=JSON.parse(fs.readFileSync('userdata/storage.json','utf8'));
  const value=fs.readFileSync('userdata/'+manifest.__external__['tavern-game'],'utf8');
  const codec=createStorageChunkCodec(),results=[];
  for(const average of [65536,131072,262144]){
    const before=await codec.encode(value,{average});
    const after=await codec.encode('\n'+value,{average});
    const uploaded=[...after.buffers].filter(([hash])=>!before.buffers.has(hash)).reduce((n,[h,b])=>n+b.length,0);
    results.push({averageBytes:average,chunks:before.manifest.chunks.length,encodeMs:before.elapsedMs,changedEncodeMs:after.elapsedMs,prefixNewBytes:uploaded});
  }
  fs.writeFileSync('.tmp/chunk-storage/chunk-sizes.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
})().catch(error=>{console.error(error);process.exitCode=1;});
