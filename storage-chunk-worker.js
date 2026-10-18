function createStorageChunkWorker() {
  const codec = createStorageChunkCodec();
  let localBuffers = new Map();
  const local = async (action, payload) => {
    if (action === 'encode') { const result = await codec.encode(payload.text); for (const [id, bytes] of result.buffers) localBuffers.set(id, bytes); return { manifest: result.manifest, elapsedMs: result.elapsedMs, scannedBytes: result.scannedBytes }; }
    if (action === 'pack') return codec.pack(payload.hashes.map(hash => { if (!localBuffers.has(hash)) throw new Error('Missing worker chunk'); return { hash, bytes: localBuffers.get(hash) }; }));
    if (action === 'decode') return codec.decode(new Uint8Array(payload.bytes), payload.manifest);
    if (action === 'release') { localBuffers.clear(); return true; }
    throw new Error('Unknown worker action');
  };
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined') return { call: local, worker: false };
  const script = `const createStorageChunkCodec = ${createStorageChunkCodec.toString()};
    const codec = createStorageChunkCodec(); let buffers = new Map();
    self.onmessage = async ({data: m}) => { try {
      let result;
      if(m.action === 'encode') {const r=await codec.encode(m.payload.text); for(const [h,b] of r.buffers) buffers.set(h,b); result={manifest:r.manifest,elapsedMs:r.elapsedMs,scannedBytes:r.scannedBytes};}
      else if(m.action === 'pack') result=codec.pack(m.payload.hashes.map(hash=>({hash,bytes:buffers.get(hash)})));
      else if(m.action === 'decode') result=await codec.decode(new Uint8Array(m.payload.bytes),m.payload.manifest);
      else if(m.action === 'release') { buffers.clear(); result=true; }
      else throw new Error('Unknown worker action');
      self.postMessage({id:m.id,result},result instanceof Uint8Array?[result.buffer]:[]);
    } catch(error) {self.postMessage({id:m.id,error:error.message});} };`;
  let url, worker;
  try { url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' })); worker = new Worker(url); }
  catch (_) { return { call: local, worker: false }; }
  finally { if (url) URL.revokeObjectURL(url); }
  let sequence = 0; const pending = new Map(); let failure = null;
  worker.onmessage = ({ data }) => { const task = pending.get(data.id); if (!task) return; pending.delete(data.id); clearTimeout(task.timer); data.error ? task.reject(new Error(data.error)) : task.resolve(data.result); };
  worker.onerror = event => { failure = new Error(event.message || 'Storage worker failed'); for (const task of pending.values()) { clearTimeout(task.timer); task.reject(failure); } pending.clear(); worker.terminate(); };
  return { worker: true, call(action, payload = {}) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++sequence; const timer = setTimeout(() => {
        failure = new Error('Storage worker timeout');
        for (const task of pending.values()) { clearTimeout(task.timer); task.reject(failure); }
        pending.clear(); worker.terminate();
      }, 60000);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, action, payload }, action === 'decode' ? [payload.bytes] : []);
    });
  } };
}
if (typeof module !== 'undefined') module.exports = { createStorageChunkWorker };
