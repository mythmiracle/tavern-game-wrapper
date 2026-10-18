const vm = require('vm');
const { Worker } = require('worker_threads');
const assert = require('assert/strict');
const { createStorageChunkCodec } = require('../storage-chunks.js');
const { createStorageChunkWorker } = require('../storage-chunk-worker.js');
function workerClient() {
  const workers=[];
  class BrowserWorker {
    constructor(code) {
      this.native=new Worker(`const {parentPort}=require('worker_threads');global.self=global;global.crypto=require('crypto').webcrypto;self.postMessage=(data,transfers)=>parentPort.postMessage(data,transfers);parentPort.on('message',data=>self.onmessage({data}));\n${code}`,{eval:true});
      this.native.on('message',data=>this.onmessage&&this.onmessage({data}));this.native.on('error',error=>this.onerror&&this.onerror({message:error.message}));workers.push(this.native);
    }
    postMessage(data,transfers){this.native.postMessage(data,transfers);}
    terminate(){this.native.terminate();}
  }
  const client=vm.runInNewContext(`(${createStorageChunkWorker.toString()})()`,{
    createStorageChunkCodec,Worker:BrowserWorker,Blob:class {constructor(parts){this.code=parts.join('');}},URL:{createObjectURL:blob=>blob.code,revokeObjectURL(){}},Map,Uint8Array,performance,setTimeout,clearTimeout,
  });
  client.dispose=()=>Promise.all(workers.map(worker=>worker.terminate()));
  return client;
}
async function test(){
  const worker=workerClient();
  try{
    assert(worker.worker);
    for(const text of ['한글😀'.repeat(40000),'x\ud800z','\ufeff'+'한글😀'.repeat(40000)]){
      const {manifest}=await worker.call('encode',{text});
      const batch=await worker.call('pack',{hashes:manifest.chunks.map(chunk=>chunk.hash)});
      assert(batch.byteLength<=1048576);
      const codec=createStorageChunkCodec();const encoded=await codec.encode(text);
      const bytes=Buffer.concat(manifest.chunks.map(chunk=>encoded.buffers.get(chunk.hash)));
      const copy=Uint8Array.from(bytes).buffer;
      assert.equal(await worker.call('decode',{bytes:copy,manifest}),text);
      assert.equal(copy.byteLength,0,'read buffer transfers ownership to the worker');
      await worker.call('release');
    }
    await assert.rejects(worker.call('pack',{hashes:['missing']}));
    console.log('PASS production Worker protocol, transferred buffers, lossless UTF-16 and error propagation');
  }finally{await worker.dispose();}
}
if(require.main===module)test().catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={workerClient};
