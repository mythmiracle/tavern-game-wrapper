const fs=require('fs');const {createStorageChunkCodec}=require('../storage-chunks.js');
(async()=>{
  const codec=createStorageChunkCodec(), vectors=[];
  for(const value of ['', '한글😀', '한글😀'.repeat(30000), 'a\ud800b', '\ufeffBOM', '\ufeff'+'한글😀'.repeat(30000), 'x'.repeat(70000)]) {
    const result=await codec.encode(value);
    vectors.push({value,manifest:result.manifest,chunks:Object.fromEntries([...result.buffers].map(([h,b])=>[h,Buffer.from(b).toString('base64')]))});
  }
  const value='A😀한글'.repeat(20000),bytes=Buffer.from(value),chunks={},manifest={encoding:'utf8',chars:value.length,bytes:bytes.length,chunks:[]};
  const boundaries=[0,2,5,6,50001,bytes.length];
  for(let i=1;i<boundaries.length;i++){const part=bytes.subarray(boundaries[i-1],boundaries[i]),hash=await codec.sha(part);manifest.chunks.push({hash,bytes:part.length});chunks[hash]=part.toString('base64');}
  manifest.root=await codec.sha(new TextEncoder().encode(codec.canonical(manifest)));
  vectors.push({value,manifest,chunks});
  fs.mkdirSync('.tmp/chunk-storage',{recursive:true});fs.writeFileSync('.tmp/chunk-storage/vectors.json',JSON.stringify(vectors));
})().catch(error=>{console.error(error);process.exitCode=1;});
