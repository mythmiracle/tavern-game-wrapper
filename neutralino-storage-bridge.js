/**
 * Wayward Tavern storage bridge v27.
 * Lossless content-defined chunks, verified snapshot commits and legacy recovery.
 * Backend sources are embedded for standalone deployment; synchronize with
 * node scripts/storage-sources.cjs sync after editing exported extension sources.
 */

(function initNeutralinoStorageBridgeV9(global) {
  'use strict';

  // BEGIN CHUNK CODEC
// This factory is also embedded in the bridge and its dedicated Web Worker.
function createStorageChunkCodec() {
  const encoder = new TextEncoder();
  const gear = new Uint32Array(256);
  let seed = 0x9e3779b9;
  for (let i = 0; i < gear.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; gear[i] = seed >>> 0; }
  const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  const sha = async bytes => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  function canonical(m) {
    return `22\n${m.encoding}\n${m.chars}\n${m.bytes}\n` + m.chunks.map(c => `${c.hash}:${c.bytes}\n`).join('');
  }
  function encodeText(text) {
    // Preserve isolated surrogates and leading BOMs (XHR strips a UTF-8 BOM).
    if (text.charCodeAt(0) === 0xfeff || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) {
      const bytes = new Uint8Array(text.length * 2);
      for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); bytes[i * 2] = c & 255; bytes[i * 2 + 1] = c >>> 8; }
      return { encoding: 'utf16le', bytes };
    }
    return { encoding: 'utf8', bytes: encoder.encode(text) };
  }
  async function encode(text, options = {}) {
    const started = performance.now();
    const { encoding, bytes } = encodeText(text);
    const min = options.min || 32768, max = options.max || 524288, mask = (options.average || 131072) - 1;
    const manifest = { encoding, chars: text.length, bytes: bytes.length, chunks: [] };
    const buffers = new Map();
    // Inline values retain a real byte encoding too; no JSON interpretation occurs.
    if (bytes.length <= 65536 && encoding === 'utf8') {
      manifest.inline = text;
      manifest.root = await sha(encoder.encode('22\ninline\n' + text));
    } else {
      let start = 0, rolling = 0;
      for (let i = 0; i < bytes.length; i++) {
        rolling = ((rolling << 1) + gear[bytes[i]]) >>> 0;
        const size = i + 1 - start;
        if (size >= min && ((rolling & mask) === 0 || size >= max) || i === bytes.length - 1) {
          const chunk = bytes.slice(start, i + 1);
          const hash = await sha(chunk);
          manifest.chunks.push({ hash, bytes: chunk.length });
          buffers.set(hash, chunk);
          start = i + 1; rolling = 0;
        }
      }
      manifest.root = await sha(encoder.encode(canonical(manifest)));
    }
    return { manifest, buffers, elapsedMs: performance.now() - started, scannedBytes: bytes.length };
  }
  async function verify(manifest) {
    const input = manifest.inline !== undefined ? '22\ninline\n' + manifest.inline : canonical(manifest);
    return await sha(encoder.encode(input)) === manifest.root;
  }
  async function snapshotRoot(save) {
    const header = `22-save\n${save.id}\n${save.baseId}\n${save.revision}\n${save.updatedAt}\n${save.legacyUpdatedAt}\n`;
    const entries = Object.keys(save.entries).sort().map(key => `${key.length}:${key}:${save.entries[key]}\n`).join('');
    return sha(encoder.encode(header + entries));
  }
  async function decode(bytes, manifest) {
    if (!await verify(manifest) || bytes.length !== manifest.bytes) throw new Error('Value manifest mismatch');
    if (manifest.inline === undefined) {
      let offset = 0;
      for (const chunk of manifest.chunks) { if (await sha(bytes.subarray(offset, offset + chunk.bytes)) !== chunk.hash) throw new Error('Chunk SHA-256 mismatch'); offset += chunk.bytes; }
    }
    let text;
    if (manifest.encoding === 'utf16le') {
      const parts = [];
      for (let offset = 0; offset < bytes.length; offset += 16384) {
        const chars = [];
        for (let i = offset; i < Math.min(bytes.length, offset + 16384); i += 2) chars.push(bytes[i] | bytes[i + 1] << 8);
        parts.push(String.fromCharCode(...chars));
      }
      text = parts.join('');
    } else text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.length !== manifest.chars || manifest.inline !== undefined && text !== manifest.inline) throw new Error('Value character length mismatch');
    return text;
  }
  function pack(items) {
    const size = items.reduce((n, item) => n + 36 + item.bytes.length, 4);
    if (size > 1048576) throw new Error('Chunk batch exceeds 1 MiB');
    const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
    view.setUint32(0, items.length, true);
    let offset = 4;
    for (const item of items) {
      for (let i = 0; i < 32; i++) bytes[offset + i] = parseInt(item.hash.slice(i * 2, i * 2 + 2), 16);
      view.setUint32(offset + 32, item.bytes.length, true);
      bytes.set(item.bytes, offset + 36); offset += 36 + item.bytes.length;
    }
    return bytes;
  }
  return { encode, decode, verify, snapshotRoot, canonical, pack, sha };
}
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
  // END CHUNK CODEC

  const BRIDGE_VERSION = 27;
  const SQLITE_EXT_VERSION = 22;
  const WINDOW_NAME_PREFIX = '__NEU_STORAGE_CARRIER_V6__:';
  const DEXIE_DB_NAME = 'WaywardTavernStorageDB';
  const SQLITE_EXTENSION_ID = 'js.neutralino.sqlite';
  const NODE_SENTINEL = '__NEU_SQLITE_NODE_V9__';

  if (
    global.__NEUTRALINO_STORAGE_BRIDGE_LOADED__ &&
    global.__storageBridge &&
    global.__storageBridge.__BRIDGE_VERSION__ === BRIDGE_VERSION
  ) {
    if (typeof global.__storageBridge.ensureReady === 'function') {
      global.__storageBridge.ensureReady();
    }
    return;
  }

  const previousBridge = global.__storageBridge || null;
  global.__NEUTRALINO_STORAGE_BRIDGE_LOADED__ = true;

  const nativeSessionStorage = (function () {
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        return window.sessionStorage;
      }
    } catch (_) {}
    return null;
  })();

  const nativeStorageMethods = (function () {
    if (typeof Storage === 'undefined' || !Storage.prototype) return null;
    return {
      getItem: Storage.prototype.getItem,
      setItem: Storage.prototype.setItem,
      removeItem: Storage.prototype.removeItem,
      clear: Storage.prototype.clear,
      key: Storage.prototype.key,
      lengthDescriptor: Object.getOwnPropertyDescriptor(Storage.prototype, 'length'),
    };
  })();

  const SESSION_KEYS = [
    'NL_OS',
    'NL_APPID',
    'NL_PORT',
    'NL_MODE',
    'NL_VERSION',
    'NL_CWD',
    'NL_PATH',
    'NL_PID',
    'NL_TOKEN',
    'NL_CONNECT_TOKEN',
  ];

  const DEFAULT_CONFIG = {
    storageDir: null,
    httpStorageBaseUrl: '/userdata',
    sqliteDbFileName: 'storage.sqlite',
    sqliteEndpointFileName: 'sqlite-endpoint.json',
    legacyMainFileName: 'storage.json',
    launcherConfigFileName: 'launcher-config.json',
    extractorFileName: 'localstorage-extractor.html',
    dexieScriptFileName: 'dexie.js',
    mountFolderName: 'game_mount',

    // 64KB 이상 대용량 키는 JSON RPC 래핑 없이 UTF-8 원문 스트리밍(/put-raw, /get-raw)으로 무손실 직통 입출력
    rawStreamingThreshold: 64 * 1024,
    jsonTreeThreshold: 32 * 1024,
    promoteThreshold: 32 * 1024,
    demoteThreshold: 24 * 1024,

    // 2계층(Dexie.js) 경량 키 캐시 주기 (0.6초)
    debounceDexieMs: 600,
    // 3계층(SQLite Extension) 원자적 원문 동기화 주기 (1.5초)
    debounceSqliteMs: 1500,
    maxFlushWaitMs: 5000,
    chunkStorage: true,
    coalesceGameAutosave: true,
    gameAutosaveDebounceMs: 250,
    gameAutosaveMaxWaitMs: 1000,

    enableContextMenu: true,
    hookWindowClose: true,
    showGameBootToast: true,
    debug: false,
  };

  function sessionGet(key) {
    if (!nativeSessionStorage) return null;
    try {
      if (nativeStorageMethods && nativeStorageMethods.getItem) {
        return nativeStorageMethods.getItem.call(nativeSessionStorage, key);
      }
      return nativeSessionStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function sessionSet(key, val) {
    if (!nativeSessionStorage) return;
    try {
      if (nativeStorageMethods && nativeStorageMethods.setItem) {
        nativeStorageMethods.setItem.call(nativeSessionStorage, key, String(val));
      } else {
        nativeSessionStorage.setItem(key, String(val));
      }
    } catch (_) {}
  }

  function normalizeSlashes(p) {
    return String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/');
  }

  function joinPath(...parts) {
    return parts
      .filter(Boolean)
      .map((p) => normalizeSlashes(p))
      .join('/')
      .replace(/\/+/g, '/');
  }

  function dirname(filePath) {
    const norm = normalizeSlashes(filePath).replace(/\/+$/, '');
    const idx = norm.lastIndexOf('/');
    return idx === -1 ? '.' : idx === 0 ? '/' : norm.slice(0, idx);
  }

  function basename(filePath) {
    const norm = normalizeSlashes(filePath).replace(/\/+$/, '');
    const idx = norm.lastIndexOf('/');
    return idx === -1 ? norm : norm.slice(idx + 1);
  }

  function stripBridgedPrefix(fileNameOrPath) {
    const norm = normalizeSlashes(fileNameOrPath);
    const dir = dirname(norm);
    const base = basename(norm);
    const cleanBase = base.replace(/^__neu_bridged_/, '');
    return dir === '.' && !norm.includes('/') ? cleanBase : joinPath(dir, cleanBase);
  }

  /**
   * 64비트급 Dual FNV-1a 해시 + 길이 조합 (노드 변경 감지용)
   */
  function fnv1aDualHex(str) {
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    const len = str.length;
    for (let i = 0; i < len; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    }
    return (
      (h1 >>> 0).toString(16).padStart(8, '0') +
      (h2 >>> 0).toString(16).padStart(8, '0') +
      '_' +
      len.toString(36)
    );
  }

  /**
   * 배열 CDC(Content-Defined Chunking) 경계 판별용 경량 해시
   */
  function fnv1aBoundary32(str) {
    let h = 0x811c9dc5;
    const len = str.length;
    const headEnd = len < 256 ? len : 256;
    for (let i = 0; i < headEnd; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    if (len > 256) {
      const tailStart = len - 64 > headEnd ? len - 64 : headEnd;
      for (let i = tailStart; i < len; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    }
    return (h ^ len) >>> 0;
  }

  function escapePathSeg(k) {
    return String(k)
      .replace(/~/g, '~0')
      .replace(/\./g, '~1')
      .replace(/@/g, '~2');
  }

  /**
   * 대용량 JSON 문자열을 상향식(Bottom-Up) 1회 순회로 논리적 하위 노드 맵(path -> { valueJson, hash })으로 분해합니다.
   */
  function decomposeJsonBottomUp(rootVal, options = {}) {
    const maxDepth = options.maxDepth || 6;
    const minNodeChars = options.minNodeChars || 4096;
    const minArrayChars = options.minArrayChars || 8192;
    const targetChunkChars = options.targetChunkChars || 32768;

    const nodes = new Map();

    function setNode(path, valueJson, precomputedHash) {
      nodes.set(path, {
        valueJson,
        hash: precomputedHash || fnv1aDualHex(valueJson),
      });
    }

    function visit(val, path, depth) {
      if (val === null || val === undefined) return 'null';
      const t = typeof val;
      if (t === 'number') return Number.isFinite(val) ? String(val) : 'null';
      if (t === 'boolean') return val ? 'true' : 'false';
      if (t === 'string') return JSON.stringify(val);
      if (t !== 'object') return 'null';

      if (Array.isArray(val)) {
        const len = val.length;
        if (len === 0) return '[]';

        const elemStrs = new Array(len);
        let totalChars = 2;
        for (let i = 0; i < len; i++) {
          const s = JSON.stringify(val[i]);
          elemStrs[i] = s === undefined ? 'null' : s;
          totalChars += elemStrs[i].length + (i > 0 ? 1 : 0);
        }

        if (depth <= maxDepth && totalChars >= minArrayChars && len > 2) {
          const chunkIds = [];
          let curItems = [];
          let curChars = 2;

          for (let i = 0; i < len; i++) {
            const itemStr = elemStrs[i];
            curItems.push(itemStr);
            curChars += itemStr.length + 1;
            const cutHash = fnv1aBoundary32(itemStr);

            const isCut =
              (curItems.length >= 2 && (cutHash & 15) === 0) ||
              curItems.length >= 48 ||
              curChars >= targetChunkChars * 3 ||
              i === len - 1;

            if (isCut) {
              const chunkJson = '[' + curItems.join(',') + ']';
              const chunkHash = fnv1aDualHex(chunkJson);
              setNode(`${path}.@${chunkHash}`, chunkJson, chunkHash);
              chunkIds.push(chunkHash);
              curItems = [];
              curChars = 2;
            }
          }

          const descriptor = JSON.stringify({
            [NODE_SENTINEL]: 'cdc_array',
            chunks: chunkIds,
          });
          setNode(path, descriptor);
          return JSON.stringify({ [NODE_SENTINEL]: 'ref', path });
        }

        return '[' + elemStrs.join(',') + ']';
      }

      const keys = Object.keys(val);
      const kLen = keys.length;
      if (kLen === 0) return '{}';

      const pairs = [];
      const branchKeys = [];
      let inlineChars = 2;
      let hasSplitChild = false;

      for (let i = 0; i < kLen; i++) {
        const k = keys[i];
        const v = val[k];
        if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;

        const childPath = `${path}.${escapePathSeg(k)}`;
        const childStr = visit(v, childPath, depth + 1);
        const isAlreadyRef = childStr.startsWith(`{"${NODE_SENTINEL}":"ref"`);

        const shouldDetachChild =
          isAlreadyRef ||
          (depth < 3 && kLen <= 64 && childStr.length >= 1024) ||
          (depth <= maxDepth && childStr.length >= minNodeChars);

        if (shouldDetachChild) {
          hasSplitChild = true;
          if (!isAlreadyRef) {
            setNode(childPath, childStr);
          }
          branchKeys.push({ k, ref: true, path: childPath });
        } else {
          const pairStr = `${JSON.stringify(k)}:${childStr}`;
          pairs.push(pairStr);
          inlineChars += pairStr.length + 1;
          branchKeys.push({ k, ref: false, valStr: childStr });
        }
      }

      if (!hasSplitChild && depth >= 1 && inlineChars < minNodeChars) {
        return '{' + pairs.join(',') + '}';
      }

      const inlineMap = {};
      const order = [];
      for (let i = 0; i < branchKeys.length; i++) {
        const item = branchKeys[i];
        order.push(item.k);
        if (!item.ref) {
          inlineMap[item.k] = item.valStr;
        }
      }

      const branchDescriptor = JSON.stringify({
        [NODE_SENTINEL]: 'branch',
        order,
        inline: inlineMap,
      });
      setNode(path, branchDescriptor);
      return JSON.stringify({ [NODE_SENTINEL]: 'ref', path });
    }

    const rootRes = visit(rootVal, '$', 0);
    if (!nodes.has('$')) {
      setNode('$', rootRes);
    }
    return nodes;
  }

  function reconstructJsonBottomUp(nodesMap) {
    const getVal = (p) => {
      if (nodesMap instanceof Map) {
        const entry = nodesMap.get(p);
        return entry && typeof entry === 'object' ? entry.valueJson : entry;
      }
      return nodesMap[p];
    };

    function buildRawJson(path) {
      const raw = getVal(path);
      if (raw === undefined || raw === null) return 'null';
      if (!raw.startsWith('{') || !raw.includes(NODE_SENTINEL)) {
        return raw;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        return raw;
      }
      const kind = parsed[NODE_SENTINEL];
      if (kind === 'branch') {
        const order = parsed.order || [];
        const inline = parsed.inline || {};
        const parts = [];
        for (let i = 0; i < order.length; i++) {
          const k = order[i];
          const keyJson = JSON.stringify(k);
          if (Object.prototype.hasOwnProperty.call(inline, k)) {
            parts.push(`${keyJson}:${inline[k]}`);
          } else {
            const childPath = `${path}.${escapePathSeg(k)}`;
            parts.push(`${keyJson}:${buildRawJson(childPath)}`);
          }
        }
        return '{' + parts.join(',') + '}';
      }
      if (kind === 'cdc_array') {
        const chunks = parsed.chunks || [];
        const sliceStrs = [];
        for (let i = 0; i < chunks.length; i++) {
          const cRaw = getVal(`${path}.@${chunks[i]}`);
          if (cRaw && cRaw.length > 2) {
            sliceStrs.push(cRaw.slice(1, -1));
          }
        }
        return '[' + sliceStrs.join(',') + ']';
      }
      if (kind === 'cdc_string') {
        const chunks = parsed.chunks || [];
        const parts = [];
        for (let i = 0; i < chunks.length; i++) {
          const cRaw = getVal(`${path}.@${chunks[i]}`);
          if (typeof cRaw === 'string') {
            parts.push(cRaw);
          }
        }
        return parts.join('');
      }
      return raw;
    }

    return buildRawJson('$');
  }

  function computeKeyNodeDelta(key, rawString, prevHashMap, options = {}) {
    let newNodes = null;
    const trimmed = rawString.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(rawString);
        newNodes = decomposeJsonBottomUp(parsed, options);
      } catch (_) {
        newNodes = null;
      }
    }

    if (!newNodes) {
      newNodes = new Map();
      const chunkSize = 32768;
      const chunkIds = [];
      for (let offset = 0; offset < rawString.length; offset += chunkSize) {
        const slice = rawString.slice(offset, offset + chunkSize);
        const h = fnv1aDualHex(slice);
        newNodes.set(`$.@${h}`, { valueJson: slice, hash: h });
        chunkIds.push(h);
      }
      const desc = JSON.stringify({ [NODE_SENTINEL]: 'cdc_string', chunks: chunkIds });
      newNodes.set('$', { valueJson: desc, hash: fnv1aDualHex(desc) });
    }

    const nodeUpserts = [];
    const nodeDeletes = [];
    const nextHashMap = new Map();
    let deltaBytes = 0;

    for (const [path, info] of newNodes.entries()) {
      nextHashMap.set(path, info.hash);
      const oldHash = prevHashMap ? prevHashMap.get(path) : undefined;
      if (oldHash !== info.hash) {
        nodeUpserts.push({
          rootKey: key,
          path,
          hash: info.hash,
          valueJson: info.valueJson,
        });
        deltaBytes += info.valueJson.length;
      }
    }

    if (prevHashMap) {
      for (const oldPath of prevHashMap.keys()) {
        if (!nextHashMap.has(oldPath)) {
          nodeDeletes.push({
            rootKey: key,
            path: oldPath,
          });
        }
      }
    }

    return {
      storageMode: 'json_tree',
      nodeCount: newNodes.size,
      byteLength: rawString.length,
      deltaBytes,
      nodeUpserts,
      nodeDeletes,
      nextHashMap,
      nodesMap: newNodes,
    };
  }

  function createJsonDeltaWorkerClient() {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
      return null;
    }
    try {
      const workerSource = [
        `const NODE_SENTINEL = ${JSON.stringify(NODE_SENTINEL)};`,
        fnv1aDualHex.toString(),
        fnv1aBoundary32.toString(),
        escapePathSeg.toString(),
        decomposeJsonBottomUp.toString(),
        computeKeyNodeDelta.toString(),
        `
        const workerHashStore = new Map();

        self.onmessage = function(ev) {
          const msg = ev.data || {};
          const reqId = msg.reqId;
          try {
            if (msg.type === 'seedHashes') {
              const hashesByKey = msg.hashesByKey || {};
              for (const k of Object.keys(hashesByKey)) {
                const m = new Map();
                const obj = hashesByKey[k] || {};
                for (const p of Object.keys(obj)) {
                  m.set(p, obj[p]);
                }
                workerHashStore.set(k, m);
              }
              self.postMessage({ reqId, ok: true });
              return;
            }
            if (msg.type === 'clearHashes') {
              if (msg.key) {
                workerHashStore.delete(msg.key);
              } else {
                workerHashStore.clear();
              }
              self.postMessage({ reqId, ok: true });
              return;
            }
            if (msg.type === 'computeDeltaBatch') {
              const items = msg.items || [];
              const results = [];
              for (let i = 0; i < items.length; i++) {
                const it = items[i];
                const prevMap = workerHashStore.get(it.key) || null;
                const delta = computeKeyNodeDelta(it.key, it.value, prevMap, msg.options || {});
                workerHashStore.set(it.key, delta.nextHashMap);
                const plainHashes = {};
                for (const [p, h] of delta.nextHashMap.entries()) {
                  plainHashes[p] = h;
                }
                results.push({
                  key: it.key,
                  storageMode: delta.storageMode,
                  nodeCount: delta.nodeCount,
                  byteLength: delta.byteLength,
                  deltaBytes: delta.deltaBytes,
                  nodeUpserts: delta.nodeUpserts,
                  nodeDeletes: delta.nodeDeletes,
                  plainHashes,
                });
              }
              self.postMessage({ reqId, ok: true, results });
              return;
            }
          } catch (err) {
            self.postMessage({ reqId, ok: false, error: String(err && err.message ? err.message : err) });
          }
        };
        `,
      ].join('\n');

      const blob = new Blob([workerSource], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);
      const pending = new Map();
      let seq = 1;

      worker.onmessage = (ev) => {
        const data = ev.data || {};
        if (data.reqId && pending.has(data.reqId)) {
          const entry = pending.get(data.reqId);
          pending.delete(data.reqId);
          if (data.ok) {
            entry.resolve(data);
          } else {
            entry.reject(new Error(data.error || 'Worker error'));
          }
        }
      };

      worker.onerror = () => {};

      return {
        call(type, payload) {
          return new Promise((resolve, reject) => {
            const reqId = 'w_' + seq++;
            pending.set(reqId, { resolve, reject });
            worker.postMessage({ ...payload, type, reqId });
          });
        },
      };
    } catch (_) {
      return null;
    }
  }

  function syncHttpGetText(url, allowCacheBusterFallback = false) {
    if (typeof XMLHttpRequest === 'undefined') return null;
    if (typeof window !== 'undefined' && window.location) {
      const proto = window.location.protocol;
      if (proto === 'about:' || proto === 'blob:' || proto === 'data:') {
        return null;
      }
    }

    const tryRequest = (targetUrl) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', targetUrl, false);
        // 주의: 다른 포트(예: 127.0.0.1:49284 -> 127.0.0.1:13661)로 동기식 XHR 요청 시
        // Cache-Control / Pragma 요청 헤더를 추가하면 브라우저가 CORS Preflight(OPTIONS)를 강제 발생시켜 차단될 수 있으므로
        // CORS-safelisted Simple GET 요청으로 전송합니다.
        xhr.overrideMimeType('text/plain; charset=utf-8');
        xhr.send(null);
        if (xhr.status === 200 && typeof xhr.responseText === 'string') {
          const text = xhr.responseText;
          if (
            (url.endsWith('.js') || url.endsWith('.json') || url.endsWith('.dat')) &&
            text.trimStart().toLowerCase().startsWith('\x3c!doctype html')
          ) {
            return null;
          }
          return text;
        }
      } catch (_) {}
      return null;
    };

    const res = tryRequest(url);
    if (res !== null) return res;

    if (allowCacheBusterFallback) {
      const sep = url.includes('?') ? '&' : '?';
      return tryRequest(`${url}${sep}_t=${Date.now()}`);
    }
    return null;
  }

  class BuiltinDexieFallback {
    constructor(dbName) {
      this.name = dbName;
      this._dbPromise = null;
      this._version = 2;
      this._storesSchema = { kv: 'key', nodes: 'id, rootKey', meta: 'key' };
      this.kv = this._createTableProxy('kv');
      this.nodes = this._createTableProxy('nodes');
      this.meta = this._createTableProxy('meta');
    }

    version(v) {
      this._version = Math.max(this._version, Number(v) || 2);
      const self = this;
      return {
        stores(schema) {
          if (schema && typeof schema === 'object') {
            self._storesSchema = { ...self._storesSchema, ...schema };
            for (const tableName of Object.keys(schema)) {
              if (!self[tableName]) {
                self[tableName] = self._createTableProxy(tableName);
              }
            }
          }
          return self;
        },
      };
    }

    open() {
      if (this._dbPromise) return this._dbPromise;
      if (typeof indexedDB === 'undefined') {
        return Promise.reject(new Error('IndexedDB를 사용할 수 없는 환경입니다.'));
      }
      this._dbPromise = new Promise((resolve, reject) => {
        try {
          const req = indexedDB.open(this.name, this._version);
          req.onupgradeneeded = (ev) => {
            const db = ev.target.result;
            for (const [tableName, spec] of Object.entries(this._storesSchema)) {
              const parts = String(spec || 'key')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
              const keyPath = parts[0] || 'key';
              let store;
              if (!db.objectStoreNames.contains(tableName)) {
                store = db.createObjectStore(tableName, { keyPath });
              } else {
                store = req.transaction.objectStore(tableName);
              }
              for (let i = 1; i < parts.length; i++) {
                const idxName = parts[i];
                if (store && !store.indexNames.contains(idxName)) {
                  try {
                    store.createIndex(idxName, idxName, { unique: false });
                  } catch (_) {}
                }
              }
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error || new Error('IndexedDB 열기 실패'));
        } catch (err) {
          reject(err);
        }
      });
      return this._dbPromise;
    }

    async transaction(_mode, ...args) {
      const callback = args[args.length - 1];
      await this.open();
      return await callback();
    }

    _createTableProxy(tableName) {
      const self = this;
      return {
        async get(key) {
          const db = await self.open();
          return new Promise((resolve, reject) => {
            const tx = db.transaction(tableName, 'readonly');
            const req = tx.objectStore(tableName).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
        },
        async put(item) {
          const db = await self.open();
          return new Promise((resolve, reject) => {
            const tx = db.transaction(tableName, 'readwrite');
            tx.objectStore(tableName).put(item);
            tx.oncomplete = () => resolve(item);
            tx.onerror = () => reject(tx.error);
          });
        },
        async bulkPut(items) {
          if (!Array.isArray(items) || items.length === 0) return;
          const db = await self.open();
          return new Promise((resolve, reject) => {
            const tx = db.transaction(tableName, 'readwrite');
            const store = tx.objectStore(tableName);
            for (const item of items) {
              store.put(item);
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        },
        async delete(key) {
          const db = await self.open();
          return new Promise((resolve, reject) => {
            const tx = db.transaction(tableName, 'readwrite');
            tx.objectStore(tableName).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        },
        async bulkDelete(keys) {
          if (!Array.isArray(keys) || keys.length === 0) return;
          const db = await self.open();
          return new Promise((resolve, reject) => {
            const tx = db.transaction(tableName, 'readwrite');
            const store = tx.objectStore(tableName);
            for (const k of keys) {
              store.delete(k);
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        },
        async clear() {
          const db = await self.open();
          return new Promise((resolve, reject) => {
            const tx = db.transaction(tableName, 'readwrite');
            tx.objectStore(tableName).clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        },
        async toArray() {
          const db = await self.open();
          return new Promise((resolve, reject) => {
            const tx = db.transaction(tableName, 'readonly');
            const req = tx.objectStore(tableName).getAll();
            req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
            req.onerror = () => reject(req.error);
          });
        },
        async count() {
          const db = await self.open();
          return new Promise((resolve, reject) => {
            const tx = db.transaction(tableName, 'readonly');
            const req = tx.objectStore(tableName).count();
            req.onsuccess = () => resolve(Number(req.result || 0));
            req.onerror = () => reject(req.error);
          });
        },
      };
    }
  }

  function ensureDexieLoaded() {
    if (typeof global.Dexie === 'function') {
      return { ClassRef: global.Dexie, isExternalDexie: !global.Dexie.__IS_BUILTIN_FALLBACK__ };
    }

    const candidates = [
      '/dexie.js',
      './dexie.js',
      '../dexie.js',
      '/dexie.min.js',
      './dexie.min.js',
      '../dexie.min.js',
      '/js/dexie.js',
      '/resources/dexie.js',
    ];

    for (const url of candidates) {
      const code = syncHttpGetText(url, false);
      if (code && code.length > 500) {
        try {
          (0, eval)(code);
          if (typeof global.Dexie === 'function') {
            return { ClassRef: global.Dexie, isExternalDexie: true };
          }
        } catch (_) {}
      }
    }

    BuiltinDexieFallback.__IS_BUILTIN_FALLBACK__ = true;
    global.Dexie = BuiltinDexieFallback;
    return { ClassRef: BuiltinDexieFallback, isExternalDexie: false };
  }

  function getSqliteExtensionSources() {
    const csharpSource = [
      'using System;',
      'using System.Collections;',
      'using System.Collections.Generic;',
      'using System.Diagnostics;',
      'using System.IO;',
      'using System.Net;',
      'using System.Net.Sockets;',
      'using System.Runtime.InteropServices;',
      'using System.Text;',
      'using System.Threading;',
      'using System.Web.Script.Serialization;',
      '',
      'namespace NeutralinoSqliteExtension',
      '{',
      '    internal static class WinSqlite3',
      '    {',
      '        private const string DllName = "winsqlite3.dll";',
      '        public const int SQLITE_OK = 0;',
      '        public const int SQLITE_ROW = 100;',
      '        public const int SQLITE_DONE = 101;',
      '        public const int SQLITE_NULL = 5;',
      '        public static readonly IntPtr SQLITE_TRANSIENT = new IntPtr(-1);',
      '',
      '        [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]',
      '        public static extern int sqlite3_open(byte[] filename, out IntPtr db);',
      '',
      '        [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]',
      '        public static extern int sqlite3_close_v2(IntPtr db);',
      '',
      '        [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]',
      '        public static extern int sqlite3_exec(IntPtr db, byte[] sql, IntPtr callback, IntPtr arg, out IntPtr errMsg);',
      '',
      '        [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]',
      '        public static extern int sqlite3_prepare_v2(IntPtr db, byte[] sql, int nByte, out IntPtr stmt, IntPtr pzTail);',
      '',
      '        [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]',
      '        public static extern int sqlite3_bind_text(IntPtr stmt, int index, byte[] val, int nByte, IntPtr destructor);',
      '',
      '        [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]',
      '        public static extern int sqlite3_bind_blob(IntPtr stmt, int index, byte[] value, int count, IntPtr destructor);',
      '',
      '        [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]',
      '        public static extern int sqlite3_bind_int64(IntPtr stmt, int index, long val);',
      '',
      '        [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]',
      '        public static extern int sqlite3_bind_null(IntPtr stmt, int index);',
      '',
      '        [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]',
      '        public static extern int sqlite3_step(IntPtr stmt);',
      '',
      '        [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]',
      '        public static extern int sqlite3_reset(IntPtr stmt);',
      '',
      '        [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]',
      '        public static extern int sqlite3_clear_bindings(IntPtr stmt);',
      '',
      '        [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]',
      '        public static extern int sqlite3_finalize(IntPtr stmt);',
      '',
      '        [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]',
      '        public static extern IntPtr sqlite3_column_blob(IntPtr stmt, int iCol);',
      '',
      '        [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]',
      '        public static extern int sqlite3_column_bytes(IntPtr stmt, int iCol);',
      '',
      '        [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]',
      '        public static extern long sqlite3_column_int64(IntPtr stmt, int iCol);',
      '',
      '        [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]',
      '        public static extern int sqlite3_column_type(IntPtr stmt, int iCol);',
      '    }',
      '',
      '    public sealed partial class SqliteDeltaStore',
      '    {',
      '        private const string SENTINEL = "__NEU_SQLITE_NODE_V9__";',
      '        private static readonly byte[] EmptyUtf8 = new byte[] { 0 };',
      '        private readonly object _sync = new object();',
      '        private readonly string _dbPath;',
      '        private IntPtr _db = IntPtr.Zero;',
      '',
      '        public SqliteDeltaStore(string dbPath)',
      '        {',
      '            _dbPath = dbPath;',
      '            string dir = Path.GetDirectoryName(Path.GetFullPath(dbPath));',
      '            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))',
      '            {',
      '                Directory.CreateDirectory(dir);',
      '            }',
      '            lock (_sync)',
      '            {',
      '                IntPtr db = GetDb();',
      '                ExecSql(db, "CREATE TABLE IF NOT EXISTS storage_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL, updated_at INTEGER NOT NULL);");',
      '                ExecSql(db, "CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, storage_mode TEXT NOT NULL, value_text TEXT, byte_length INTEGER NOT NULL DEFAULT 0, node_count INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);");',
      '                ExecSql(db, "CREATE TABLE IF NOT EXISTS json_nodes (root_key TEXT NOT NULL, node_path TEXT NOT NULL, node_hash TEXT NOT NULL, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (root_key, node_path)) WITHOUT ROWID;");',
      '                ChunkSchema();',
      '                // Legacy data is read without destructive conversion until a verified commit.',
      '            }',
      '        }',
      '',
      '        private IntPtr GetDb()',
      '        {',
      '            if (_db != IntPtr.Zero) return _db;',
      '            byte[] pathBytes = ToNullTerminatedUtf8(_dbPath);',
      '            IntPtr db;',
      '            int rc = WinSqlite3.sqlite3_open(pathBytes, out db);',
      '            if (rc != WinSqlite3.SQLITE_OK || db == IntPtr.Zero)',
      '            {',
      '                throw new Exception("winsqlite3 open failed: " + rc);',
      '            }',
      '            ExecSql(db, "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -32000; PRAGMA mmap_size = 268435456;");',
      '            _db = db;',
      '            return _db;',
      '        }',
      '',
      '        private void MigrateLegacyJsonTreesIfNeeded(IntPtr db)',
      '        {',
      '            try',
      '            {',
      '                long nonInlineCount = QueryScalarInt64(db, "SELECT COUNT(*) FROM kv_store WHERE storage_mode != \'inline\';");',
      '                long nodeRowsCount = QueryScalarInt64(db, "SELECT COUNT(*) FROM json_nodes;");',
      '                if (nonInlineCount <= 0 && nodeRowsCount <= 0) return;',
      '                if (nonInlineCount > 0 && nodeRowsCount > 0)',
      '                {',
      '                    JavaScriptSerializer ser = new JavaScriptSerializer();',
      '                    ser.MaxJsonLength = int.MaxValue;',
      '                    ser.RecursionLimit = 1024;',
      '                    Dictionary<string, Dictionary<string, string>> nodesByKey = new Dictionary<string, Dictionary<string, string>>();',
      '                    IntPtr nodeStmt;',
      '                    PrepareStmt(db, "SELECT root_key, node_path, value_json FROM json_nodes;", out nodeStmt);',
      '                    try',
      '                    {',
      '                        while (WinSqlite3.sqlite3_step(nodeStmt) == WinSqlite3.SQLITE_ROW)',
      '                        {',
      '                            string rk = GetColumnText(nodeStmt, 0) ?? "";',
      '                            string np = GetColumnText(nodeStmt, 1) ?? "";',
      '                            string vj = GetColumnText(nodeStmt, 2) ?? "null";',
      '                            Dictionary<string, string> nm;',
      '                            if (!nodesByKey.TryGetValue(rk, out nm)) { nm = new Dictionary<string, string>(); nodesByKey[rk] = nm; }',
      '                            nm[np] = vj;',
      '                        }',
      '                    }',
      '                    finally { if (nodeStmt != IntPtr.Zero) WinSqlite3.sqlite3_finalize(nodeStmt); }',
      '                    List<string> treeKeys = new List<string>();',
      '                    IntPtr kvStmt;',
      '                    PrepareStmt(db, "SELECT key FROM kv_store WHERE storage_mode != \'inline\';", out kvStmt);',
      '                    try',
      '                    {',
      '                        while (WinSqlite3.sqlite3_step(kvStmt) == WinSqlite3.SQLITE_ROW)',
      '                        {',
      '                            string k = GetColumnText(kvStmt, 0);',
      '                            if (!string.IsNullOrEmpty(k)) treeKeys.Add(k);',
      '                        }',
      '                    }',
      '                    finally { if (kvStmt != IntPtr.Zero) WinSqlite3.sqlite3_finalize(kvStmt); }',
      '                    ExecSql(db, "BEGIN IMMEDIATE TRANSACTION;");',
      '                    try',
      '                    {',
      '                        IntPtr upStmt;',
      '                        PrepareStmt(db, "UPDATE kv_store SET storage_mode = \'inline\', value_text = ?, byte_length = ?, node_count = 1 WHERE key = ?;", out upStmt);',
      '                        try',
      '                        {',
      '                            foreach (string tk in treeKeys)',
      '                            {',
      '                                Dictionary<string, string> nm;',
      '                                if (nodesByKey.TryGetValue(tk, out nm) && nm.Count > 0)',
      '                                {',
      '                                    string fullJson = ReconstructRootKey(nm, ser);',
      '                                    WinSqlite3.sqlite3_reset(upStmt);',
      '                                    BindText(upStmt, 1, fullJson);',
      '                                    WinSqlite3.sqlite3_bind_int64(upStmt, 2, (long)fullJson.Length);',
      '                                    BindText(upStmt, 3, tk);',
      '                                    StepDone(upStmt, "migrateTreeKey");',
      '                                }',
      '                            }',
      '                        }',
      '                        finally { if (upStmt != IntPtr.Zero) WinSqlite3.sqlite3_finalize(upStmt); }',
      '                        ExecSql(db, "DELETE FROM json_nodes;");',
      '                        ExecSql(db, "COMMIT;");',
      '                    }',
      '                    catch { try { ExecSql(db, "ROLLBACK;"); } catch { } return; }',
      '                }',
      '                else if (nodeRowsCount > 0) { ExecSql(db, "DELETE FROM json_nodes;"); }',
      '                try { ExecSql(db, "PRAGMA wal_checkpoint(TRUNCATE);"); } catch { }',
      '            }',
      '            catch { }',
      '        }',
      '',
      '        public void Shutdown()',
      '        {',
      '            lock (_sync)',
      '            {',
      '                if (_db != IntPtr.Zero)',
      '                {',
      '                    try { ExecSql(_db, "PRAGMA wal_checkpoint(TRUNCATE);"); } catch { }',
      '                    try { ExecSql(_db, "PRAGMA journal_mode = DELETE;"); } catch { }',
      '                    try { WinSqlite3.sqlite3_close_v2(_db); } catch { }',
      '                    _db = IntPtr.Zero;',
      '                }',
      '            }',
      '        }',
      '',
      '        private static byte[] ToNullTerminatedUtf8(string s)',
      '        {',
      '            byte[] utf8 = Encoding.UTF8.GetBytes(s ?? "");',
      '            byte[] res = new byte[utf8.Length + 1];',
      '            Buffer.BlockCopy(utf8, 0, res, 0, utf8.Length);',
      '            res[utf8.Length] = 0;',
      '            return res;',
      '        }',
      '',
      '        private static void ExecSql(IntPtr db, string sql)',
      '        {',
      '            IntPtr err;',
      '            int rc = WinSqlite3.sqlite3_exec(db, ToNullTerminatedUtf8(sql), IntPtr.Zero, IntPtr.Zero, out err);',
      '            if (rc != WinSqlite3.SQLITE_OK)',
      '            {',
      '                throw new Exception("sqlite3_exec failed (" + rc + "): " + sql);',
      '            }',
      '        }',
      '',
      '        private static void PrepareStmt(IntPtr db, string sql, out IntPtr stmt)',
      '        {',
      '            int rc = WinSqlite3.sqlite3_prepare_v2(db, ToNullTerminatedUtf8(sql), -1, out stmt, IntPtr.Zero);',
      '            if (rc != WinSqlite3.SQLITE_OK || stmt == IntPtr.Zero)',
      '            {',
      '                throw new Exception("sqlite3_prepare_v2 failed (" + rc + "): " + sql);',
      '            }',
      '        }',
      '',
      '        private static void StepDone(IntPtr stmt, string context)',
      '        {',
      '            int rc = WinSqlite3.sqlite3_step(stmt);',
      '            if (rc != WinSqlite3.SQLITE_DONE && rc != WinSqlite3.SQLITE_ROW && rc != WinSqlite3.SQLITE_OK)',
      '            {',
      '                throw new Exception("sqlite3_step failed (" + rc + ") in " + context);',
      '            }',
      '        }',
      '',
      '        private static void BindText(IntPtr stmt, int idx, string val)',
      '        {',
      '            if (val == null)',
      '            {',
      '                int rcNull = WinSqlite3.sqlite3_bind_null(stmt, idx);',
      '                if (rcNull != WinSqlite3.SQLITE_OK) throw new Exception("sqlite3_bind_null failed: " + rcNull);',
      '                return;',
      '            }',
      '            byte[] b = new UTF8Encoding(false, true).GetBytes(val);',
      '            int byteLen = b.Length;',
      '            if (byteLen == 0) b = EmptyUtf8;',
      '            int rc = WinSqlite3.sqlite3_bind_text(stmt, idx, b, byteLen, WinSqlite3.SQLITE_TRANSIENT);',
      '            if (rc != WinSqlite3.SQLITE_OK)',
      '            {',
      '                throw new Exception("sqlite3_bind_text failed: " + rc);',
      '            }',
      '        }',
      '',
      '        private static string GetColumnText(IntPtr stmt, int col)',
      '        {',
      '            if (WinSqlite3.sqlite3_column_type(stmt, col) == WinSqlite3.SQLITE_NULL) return null;',
      '            int len = WinSqlite3.sqlite3_column_bytes(stmt, col);',
      '            if (len <= 0) return "";',
      '            IntPtr ptr = WinSqlite3.sqlite3_column_blob(stmt, col);',
      '            if (ptr == IntPtr.Zero) return "";',
      '            byte[] buf = new byte[len];',
      '            Marshal.Copy(ptr, buf, 0, len);',
      '            return Encoding.UTF8.GetString(buf);',
      '        }',
      '',
      '        private static long QueryScalarInt64(IntPtr db, string sql)',
      '        {',
      '            IntPtr stmt;',
      '            PrepareStmt(db, sql, out stmt);',
      '            try',
      '            {',
      '                if (WinSqlite3.sqlite3_step(stmt) == WinSqlite3.SQLITE_ROW)',
      '                {',
      '                    return WinSqlite3.sqlite3_column_int64(stmt, 0);',
      '                }',
      '                return 0;',
      '            }',
      '            finally',
      '            {',
      '                if (stmt != IntPtr.Zero) WinSqlite3.sqlite3_finalize(stmt);',
      '            }',
      '        }',
      '',
      '        private static long NowMs()',
      '        {',
      '            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;',
      '        }',
      '',
      '        private static string EscapePathSeg(string k)',
      '        {',
      '            return (k ?? "").Replace("~", "~0").Replace(".", "~1").Replace("@", "~2");',
      '        }',
      '',
      '        public Dictionary<string, object> PutRawValueBytes(string key, byte[] utf8Bytes, long charLen, long revision, long updatedAt, bool checkpoint)',
      '        {',
      '            lock (_sync)',
      '            {',
      '                if (HasChunkSave()) throw new Exception("Chunk save requires v22 protocol");',
      '                DateTime t0 = DateTime.UtcNow;',
      '                long now = updatedAt > 0 ? updatedAt : NowMs();',
      '                long rev = revision > 0 ? revision : 1;',
      '                byte[] b = utf8Bytes ?? new byte[0];',
      '                int byteLen = b.Length;',
      '                long effectiveLen = charLen > 0 ? charLen : (long)byteLen;',
      '                IntPtr db = GetDb();',
      '                ExecSql(db, "BEGIN IMMEDIATE TRANSACTION;");',
      '                try',
      '                {',
      '                    IntPtr upStmt;',
      '                    PrepareStmt(db, "INSERT OR REPLACE INTO kv_store (key, storage_mode, value_text, byte_length, node_count, revision, updated_at) VALUES (?, \'inline\', ?, ?, 1, ?, ?);", out upStmt);',
      '                    try',
      '                    {',
      '                        BindText(upStmt, 1, key ?? "");',
      '                        byte[] bindBuf = byteLen == 0 ? EmptyUtf8 : b;',
      '                        int rc = WinSqlite3.sqlite3_bind_text(upStmt, 2, bindBuf, byteLen, WinSqlite3.SQLITE_TRANSIENT);',
      '                        if (rc != WinSqlite3.SQLITE_OK) throw new Exception("sqlite3_bind_text raw failed: " + rc);',
      '                        WinSqlite3.sqlite3_bind_int64(upStmt, 3, effectiveLen);',
      '                        WinSqlite3.sqlite3_bind_int64(upStmt, 4, rev);',
      '                        WinSqlite3.sqlite3_bind_int64(upStmt, 5, now);',
      '                        StepDone(upStmt, "putRawKv");',
      '                    }',
      '                    finally { if (upStmt != IntPtr.Zero) WinSqlite3.sqlite3_finalize(upStmt); }',
      '                    ExecSql(db, "COMMIT;");',
      '                }',
      '                catch { try { ExecSql(db, "ROLLBACK;"); } catch { } throw; }',
      '                if (checkpoint)',
      '                {',
      '                    try { ExecSql(db, "PRAGMA wal_checkpoint(PASSIVE);"); } catch { }',
      '                }',
      '                Dictionary<string, object> res = new Dictionary<string, object>();',
      '                res["ok"] = true;',
      '                res["rawSaved"] = true;',
      '                res["version"] = 22;',
      '                res["backend"] = "winsqlite3-native";',
      '                res["elapsedMs"] = Math.Round((DateTime.UtcNow - t0).TotalMilliseconds, 2);',
      '                res["byteLength"] = byteLen;',
      '                return res;',
      '            }',
      '        }',
      '',
      '        public byte[] GetRawValueBytes(string key, JavaScriptSerializer ser)',
      '        {',
      '            lock (_sync)',
      '            {',
      '                IntPtr db = GetDb();',
      '                IntPtr stmt;',
      '                PrepareStmt(db, "SELECT storage_mode, value_text FROM kv_store WHERE key = ?;", out stmt);',
      '                try',
      '                {',
      '                    BindText(stmt, 1, key ?? "");',
      '                    if (WinSqlite3.sqlite3_step(stmt) == WinSqlite3.SQLITE_ROW)',
      '                    {',
      '                        string mode = GetColumnText(stmt, 0) ?? "inline";',
      '                        if (mode == "inline")',
      '                        {',
      '                            if (WinSqlite3.sqlite3_column_type(stmt, 1) == WinSqlite3.SQLITE_NULL) return new byte[0];',
      '                            int len = WinSqlite3.sqlite3_column_bytes(stmt, 1);',
      '                            if (len <= 0) return new byte[0];',
      '                            IntPtr ptr = WinSqlite3.sqlite3_column_blob(stmt, 1);',
      '                            if (ptr == IntPtr.Zero) return new byte[0];',
      '                            byte[] buf = new byte[len];',
      '                            Marshal.Copy(ptr, buf, 0, len);',
      '                            return buf;',
      '                        }',
      '                    }',
      '                    else { return null; }',
      '                }',
      '                finally { if (stmt != IntPtr.Zero) WinSqlite3.sqlite3_finalize(stmt); }',
      '                Dictionary<string, string> nm = new Dictionary<string, string>();',
      '                IntPtr nStmt;',
      '                PrepareStmt(db, "SELECT node_path, value_json FROM json_nodes WHERE root_key = ?;", out nStmt);',
      '                try',
      '                {',
      '                    BindText(nStmt, 1, key ?? "");',
      '                    while (WinSqlite3.sqlite3_step(nStmt) == WinSqlite3.SQLITE_ROW)',
      '                    {',
      '                        nm[GetColumnText(nStmt, 0) ?? ""] = GetColumnText(nStmt, 1) ?? "null";',
      '                    }',
      '                }',
      '                finally { if (nStmt != IntPtr.Zero) WinSqlite3.sqlite3_finalize(nStmt); }',
      '                return Encoding.UTF8.GetBytes(ReconstructRootKey(nm, ser) ?? "");',
      '            }',
      '        }',
      '',
      '        public Dictionary<string, object> ExportMeta(JavaScriptSerializer ser)',
      '        {',
      '            lock (_sync)',
      '            {',
      '                if (HasChunkSave()) return ExportChunkMeta(null);',
      '                DateTime t0 = DateTime.UtcNow;',
      '                Dictionary<string, string> inlineData = new Dictionary<string, string>();',
      '                List<string> largeKeys = new List<string>();',
      '                long maxUpdatedAt = 0;',
      '                int totalKeys = 0;',
      '                IntPtr db = GetDb();',
      '                IntPtr kvStmt;',
      '                PrepareStmt(db, "SELECT key, storage_mode, CASE WHEN storage_mode = \'inline\' AND byte_length <= 65536 AND LENGTH(value_text) <= 65536 THEN value_text ELSE NULL END, byte_length, updated_at FROM kv_store;", out kvStmt);',
      '                try',
      '                {',
      '                    while (WinSqlite3.sqlite3_step(kvStmt) == WinSqlite3.SQLITE_ROW)',
      '                    {',
      '                        string k = GetColumnText(kvStmt, 0) ?? "";',
      '                        string mode = GetColumnText(kvStmt, 1) ?? "inline";',
      '                        string smallText = GetColumnText(kvStmt, 2);',
      '                        long bLen = WinSqlite3.sqlite3_column_int64(kvStmt, 3);',
      '                        long upd = WinSqlite3.sqlite3_column_int64(kvStmt, 4);',
      '                        if (upd > maxUpdatedAt) maxUpdatedAt = upd;',
      '                        totalKeys++;',
      '                        if (mode == "inline" && smallText != null && bLen <= 65536) inlineData[k] = smallText;',
      '                        else largeKeys.Add(k);',
      '                    }',
      '                }',
      '                finally { if (kvStmt != IntPtr.Zero) WinSqlite3.sqlite3_finalize(kvStmt); }',
      '                Dictionary<string, object> res = new Dictionary<string, object>();',
      '                res["ok"] = true;',
      '                res["version"] = 22;',
      '                res["backend"] = "winsqlite3-native";',
      '                res["updatedAt"] = maxUpdatedAt;',
      '                res["totalKeys"] = totalKeys;',
      '                res["saveCommit"] = GetSaveCommit(ser);',
      '                res["inlineData"] = inlineData;',
      '                res["largeKeys"] = largeKeys;',
      '                res["elapsedMs"] = Math.Round((DateTime.UtcNow - t0).TotalMilliseconds, 2);',
      '                return res;',
      '            }',
      '        }',
      '',
      '        private Dictionary<string, object> ReadSaveCommit(JavaScriptSerializer ser)',
      '        {',
      '            IntPtr stmt;',
      '            PrepareStmt(GetDb(), "SELECT meta_value FROM storage_meta WHERE meta_key = \'save_commit\';", out stmt);',
      '            try',
      '            {',
      '                if (WinSqlite3.sqlite3_step(stmt) != WinSqlite3.SQLITE_ROW) return null;',
      '                return ser.Deserialize<Dictionary<string, object>>(GetColumnText(stmt, 0));',
      '            }',
      '            finally { WinSqlite3.sqlite3_finalize(stmt); }',
      '        }',
      '',
      '        private Dictionary<string, string> HashStoredValues()',
      '        {',
      '            var hashes = new Dictionary<string, string>(StringComparer.Ordinal);',
      '            IntPtr stmt;',
      '            PrepareStmt(GetDb(), "SELECT key, value_text, storage_mode FROM kv_store ORDER BY key;", out stmt);',
      '            try',
      '            {',
      '                int rc;',
      '                while ((rc = WinSqlite3.sqlite3_step(stmt)) == WinSqlite3.SQLITE_ROW)',
      '                {',
      '                    if (GetColumnText(stmt, 2) != "inline") throw new Exception("Unverified legacy storage mode");',
      '                    using (var sha = System.Security.Cryptography.SHA256.Create())',
      '                    {',
      '                        byte[] bytes = Encoding.UTF8.GetBytes(GetColumnText(stmt, 1) ?? "");',
      '                        hashes[GetColumnText(stmt, 0)] = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();',
      '                    }',
      '                }',
      '                if (rc != WinSqlite3.SQLITE_DONE) throw new Exception("Reading save hashes failed: " + rc);',
      '            }',
      '            finally { WinSqlite3.sqlite3_finalize(stmt); }',
      '            return hashes;',
      '        }',
      '',
      '        private static bool SameHashes(Dictionary<string, string> actual, Dictionary<string, object> expected)',
      '        {',
      '            if (expected == null || actual.Count != expected.Count) return false;',
      '            foreach (var entry in actual)',
      '            {',
      '                object value;',
      '                if (!expected.TryGetValue(entry.Key, out value) || entry.Value != Convert.ToString(value)) return false;',
      '            }',
      '            return true;',
      '        }',
      '',
      '        public Dictionary<string, object> GetSaveCommit(JavaScriptSerializer ser)',
      '        {',
      '            lock (_sync)',
      '            {',
      '                if (HasChunkSave()) return ChunkSave(null);',
      '                var commit = ReadSaveCommit(ser);',
      '                if (commit == null) return null;',
      '                try { commit["verified"] = SameHashes(HashStoredValues(), commit["hashes"] as Dictionary<string, object>); }',
      '                catch { commit["verified"] = false; }',
      '                return commit;',
      '            }',
      '        }',
      '',
      '        public Dictionary<string, object> CommitSave(Dictionary<string, object> batch, JavaScriptSerializer ser)',
      '        {',
      '            lock (_sync)',
      '            {',
      '                if (batch == null || !batch.ContainsKey("expectedHashes") || !batch.ContainsKey("id")) throw new Exception("Save manifest is required");',
      '                var expected = batch["expectedHashes"] as Dictionary<string, object>;',
      '                if (expected == null) throw new Exception("Invalid save manifest");',
      '                string id = Convert.ToString(batch["id"]);',
      '                if (string.IsNullOrEmpty(id)) throw new Exception("Save id is required");',
      '                IntPtr db = GetDb();',
      '                ExecSql(db, "BEGIN IMMEDIATE TRANSACTION;");',
      '                Dictionary<string, object> commit;',
      '                try',
      '                {',
      '                    var previous = ReadSaveCommit(ser);',
      '                    string previousId = CurrentSaveId();',
      '                    string baseId = batch.ContainsKey("baseId") ? Convert.ToString(batch["baseId"]) : "";',
      '                    if (previousId != baseId) throw new Exception("Save conflict: reload the committed save before retrying");',
      '                    if (batch.ContainsKey("clearAll") && Convert.ToBoolean(batch["clearAll"]))',
      '                        ExecSql(db, "DELETE FROM kv_store; DELETE FROM json_nodes;");',
      '                    if (batch.ContainsKey("kvDeletes"))',
      '                    {',
      '                        foreach (object key in (IEnumerable)batch["kvDeletes"])',
      '                        {',
      '                            IntPtr stmt;',
      '                            PrepareStmt(db, "DELETE FROM kv_store WHERE key = ?;", out stmt);',
      '                            try { BindText(stmt, 1, Convert.ToString(key)); StepDone(stmt, "commitDelete"); }',
      '                            finally { WinSqlite3.sqlite3_finalize(stmt); }',
      '                            PrepareStmt(db, "DELETE FROM json_nodes WHERE root_key = ?;", out stmt);',
      '                            try { BindText(stmt, 1, Convert.ToString(key)); StepDone(stmt, "commitDeleteNodes"); }',
      '                            finally { WinSqlite3.sqlite3_finalize(stmt); }',
      '                        }',
      '                    }',
      '                    long updatedAt = Convert.ToInt64(batch["updatedAt"]);',
      '                    long revision = Convert.ToInt64(batch["revision"]);',
      '                    IntPtr upsert;',
      '                    PrepareStmt(db, "INSERT OR REPLACE INTO kv_store (key, storage_mode, value_text, byte_length, node_count, revision, updated_at) VALUES (?, \'inline\', ?, ?, 1, ?, ?);", out upsert);',
      '                    try',
      '                    {',
      '                        foreach (object item in (IEnumerable)batch["kvUpserts"])',
      '                        {',
      '                            var value = item as Dictionary<string, object>;',
      '                            if (value == null || !value.ContainsKey("key") || !value.ContainsKey("valueText")) throw new Exception("Invalid save entry");',
      '                            string text = Convert.ToString(value["valueText"]);',
      '                            WinSqlite3.sqlite3_reset(upsert);',
      '                            BindText(upsert, 1, Convert.ToString(value["key"])); BindText(upsert, 2, text);',
      '                            WinSqlite3.sqlite3_bind_int64(upsert, 3, text.Length);',
      '                            WinSqlite3.sqlite3_bind_int64(upsert, 4, revision);',
      '                            WinSqlite3.sqlite3_bind_int64(upsert, 5, updatedAt);',
      '                            StepDone(upsert, "commitUpsert");',
      '                        }',
      '                    }',
      '                    finally { WinSqlite3.sqlite3_finalize(upsert); }',
      '                    var actual = HashStoredValues();',
      '                    if (!SameHashes(actual, expected)) throw new Exception("Save verification failed: key list or SHA-256 mismatch");',
      '                    commit = new Dictionary<string, object> {',
      '                        {"id", id}, {"revision", revision}, {"updatedAt", updatedAt},',
      '                        {"legacyUpdatedAt", batch.ContainsKey("legacyUpdatedAt") ? batch["legacyUpdatedAt"] : 0},',
      '                        {"hashes", actual}, {"keyCount", actual.Count}, {"verified", true}',
      '                    };',
      '                    IntPtr meta;',
      '                    PrepareStmt(db, "INSERT OR REPLACE INTO storage_meta (meta_key, meta_value, updated_at) VALUES (\'save_commit\', ?, ?);", out meta);',
      '                    try { BindText(meta, 1, ser.Serialize(commit)); WinSqlite3.sqlite3_bind_int64(meta, 2, updatedAt); StepDone(meta, "saveCommit"); ChunkExec("DELETE FROM storage_meta WHERE meta_key = \'chunk_active\'"); }',
      '                    finally { WinSqlite3.sqlite3_finalize(meta); }',
      '                    ExecSql(db, "COMMIT;");',
      '                }',
      '                catch { try { ExecSql(db, "ROLLBACK;"); } catch { } throw; }',
      '                if (batch.ContainsKey("checkpoint") && Convert.ToBoolean(batch["checkpoint"]))',
      '                    try { ExecSql(db, "PRAGMA wal_checkpoint(PASSIVE);"); } catch { }',
      '                return new Dictionary<string, object> { {"ok", true}, {"version", 21}, {"backend", "winsqlite3-native"}, {"commit", commit} };',
      '            }',
      '        }',
      '',
      '        public Dictionary<string, object> ApplyDelta(Dictionary<string, object> batch)',
      '        {',
      '            lock (_sync)',
      '            {',
      '                if (HasChunkSave()) throw new Exception("Chunk save requires v22 protocol");',
      '                DateTime t0 = DateTime.UtcNow;',
      '                long now = NowMs();',
      '                int kvUpsertCount = 0;',
      '                int nodeUpsertCount = 0;',
      '                int nodeDeleteCount = 0;',
      '                long totalKvRows = 0;',
      '                long totalNodeRows = 0;',
      '                bool clearAll = batch != null && batch.ContainsKey("clearAll") && Convert.ToBoolean(batch["clearAll"]);',
      '                bool checkpointReq = batch != null && batch.ContainsKey("checkpoint") && Convert.ToBoolean(batch["checkpoint"]);',
      '                bool anyDeleted = clearAll;',
      '',
      '                IntPtr db = GetDb();',
      '                ExecSql(db, "BEGIN IMMEDIATE TRANSACTION;");',
      '                try',
      '                {',
      '                    if (clearAll)',
      '                    {',
      '                        ExecSql(db, "DELETE FROM kv_store; DELETE FROM json_nodes;");',
      '                    }',
      '',
      '                    if (batch != null && batch.ContainsKey("kvDeletes") && batch["kvDeletes"] is IEnumerable)',
      '                    {',
      '                        IntPtr delKvStmt, delNodeByRootStmt;',
      '                        PrepareStmt(db, "DELETE FROM kv_store WHERE key = ?;", out delKvStmt);',
      '                        PrepareStmt(db, "DELETE FROM json_nodes WHERE root_key = ?;", out delNodeByRootStmt);',
      '                        try',
      '                        {',
      '                            foreach (object kObj in (IEnumerable)batch["kvDeletes"])',
      '                            {',
      '                                string k = Convert.ToString(kObj);',
      '                                WinSqlite3.sqlite3_reset(delKvStmt);',
      '                                BindText(delKvStmt, 1, k);',
      '                                StepDone(delKvStmt, "delKv");',
      '',
      '                                WinSqlite3.sqlite3_reset(delNodeByRootStmt);',
      '                                BindText(delNodeByRootStmt, 1, k);',
      '                                StepDone(delNodeByRootStmt, "delNodeByRoot");',
      '                                anyDeleted = true;',
      '                            }',
      '                        }',
      '                        finally',
      '                        {',
      '                            if (delKvStmt != IntPtr.Zero) WinSqlite3.sqlite3_finalize(delKvStmt);',
      '                            if (delNodeByRootStmt != IntPtr.Zero) WinSqlite3.sqlite3_finalize(delNodeByRootStmt);',
      '                        }',
      '                    }',
      '',
      '                    if (batch != null && batch.ContainsKey("kvUpserts") && batch["kvUpserts"] is IEnumerable)',
      '                    {',
      '                        IntPtr upKvStmt;',
      '                        PrepareStmt(db, "INSERT OR REPLACE INTO kv_store (key, storage_mode, value_text, byte_length, node_count, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?);", out upKvStmt);',
      '                        try',
      '                        {',
      '                            foreach (object item in (IEnumerable)batch["kvUpserts"])',
      '                            {',
      '                                Dictionary<string, object> u = item as Dictionary<string, object>;',
      '                                if (u == null) continue;',
      '                                string k = u.ContainsKey("key") ? Convert.ToString(u["key"]) : "";',
      '                                string mode = u.ContainsKey("storageMode") ? Convert.ToString(u["storageMode"]) : "inline";',
      '                                string vText = (u.ContainsKey("valueText") && u["valueText"] != null) ? Convert.ToString(u["valueText"]) : null;',
      '                                long bLen = u.ContainsKey("byteLength") ? Convert.ToInt64(u["byteLength"]) : 0;',
      '                                long nCnt = u.ContainsKey("nodeCount") ? Convert.ToInt64(u["nodeCount"]) : 1;',
      '                                long rev = u.ContainsKey("revision") ? Convert.ToInt64(u["revision"]) : 1;',
      '                                long upd = u.ContainsKey("updatedAt") ? Convert.ToInt64(u["updatedAt"]) : now;',
      '',
      '                                WinSqlite3.sqlite3_reset(upKvStmt);',
      '                                BindText(upKvStmt, 1, k);',
      '                                BindText(upKvStmt, 2, mode);',
      '                                BindText(upKvStmt, 3, vText);',
      '                                WinSqlite3.sqlite3_bind_int64(upKvStmt, 4, bLen);',
      '                                WinSqlite3.sqlite3_bind_int64(upKvStmt, 5, nCnt);',
      '                                WinSqlite3.sqlite3_bind_int64(upKvStmt, 6, rev);',
      '                                WinSqlite3.sqlite3_bind_int64(upKvStmt, 7, upd);',
      '                                StepDone(upKvStmt, "upKv");',
      '                                kvUpsertCount++;',
      '                            }',
      '                        }',
      '                        finally',
      '                        {',
      '                            if (upKvStmt != IntPtr.Zero) WinSqlite3.sqlite3_finalize(upKvStmt);',
      '                        }',
      '                    }',
      '',
      '                    ExecSql(db, "COMMIT;");',
      '                    if (anyDeleted || checkpointReq)',
      '                    {',
      '                        try { ExecSql(db, "PRAGMA wal_checkpoint(PASSIVE);"); } catch { }',
      '                    }',
      '                    totalKvRows = QueryScalarInt64(db, "SELECT COUNT(*) FROM kv_store;");',
      '                }',
      '                catch',
      '                {',
      '                    try { ExecSql(db, "ROLLBACK;"); } catch { }',
      '                    throw;',
      '                }',
      '',
      '                double elapsedMs = (DateTime.UtcNow - t0).TotalMilliseconds;',
      '                Dictionary<string, object> res = new Dictionary<string, object>();',
      '                res["ok"] = true;',
      '                res["version"] = 22;',
      '                res["backend"] = "winsqlite3-native";',
      '                res["elapsedMs"] = Math.Round(elapsedMs, 2);',
      '                res["kvUpserts"] = kvUpsertCount;',
      '                res["nodeUpserts"] = nodeUpsertCount;',
      '                res["nodeDeletes"] = nodeDeleteCount;',
      '                res["totalKvRows"] = totalKvRows;',
      '                res["totalNodeRows"] = totalNodeRows;',
      '                return res;',
      '            }',
      '        }',
      '',
      '        private string ReconstructRootKey(Dictionary<string, string> nodesMap, JavaScriptSerializer ser)',
      '        {',
      '            return BuildRawJson("$", nodesMap, ser);',
      '        }',
      '',
      '        private string BuildRawJson(string path, Dictionary<string, string> nodesMap, JavaScriptSerializer ser)',
      '        {',
      '            string raw;',
      '            if (!nodesMap.TryGetValue(path, out raw) || raw == null) return "null";',
      '            if (!raw.StartsWith("{") || raw.IndexOf(SENTINEL, StringComparison.Ordinal) < 0) return raw;',
      '',
      '            Dictionary<string, object> parsed = ser.Deserialize<Dictionary<string, object>>(raw);',
      '            if (parsed == null || !parsed.ContainsKey(SENTINEL)) return raw;',
      '            string kind = Convert.ToString(parsed[SENTINEL]);',
      '            if (kind == "branch")',
      '            {',
      '                IEnumerable order = parsed.ContainsKey("order") ? (parsed["order"] as IEnumerable) : null;',
      '                Dictionary<string, object> inlineMap = parsed.ContainsKey("inline") ? (parsed["inline"] as Dictionary<string, object>) : null;',
      '                StringBuilder sb = new StringBuilder();',
      '                sb.Append("{");',
      '                bool first = true;',
      '                if (order != null)',
      '                {',
      '                    foreach (object kObj in order)',
      '                    {',
      '                        string k = Convert.ToString(kObj);',
      '                        if (!first) sb.Append(",");',
      '                        first = false;',
      '                        sb.Append(ser.Serialize(k));',
      '                        sb.Append(":");',
      '                        if (inlineMap != null && inlineMap.ContainsKey(k))',
      '                        {',
      '                            sb.Append(Convert.ToString(inlineMap[k]));',
      '                        }',
      '                        else',
      '                        {',
      '                            string childPath = path + "." + EscapePathSeg(k);',
      '                            sb.Append(BuildRawJson(childPath, nodesMap, ser));',
      '                        }',
      '                    }',
      '                }',
      '                sb.Append("}");',
      '                return sb.ToString();',
      '            }',
      '            if (kind == "cdc_array")',
      '            {',
      '                IEnumerable chunks = parsed.ContainsKey("chunks") ? (parsed["chunks"] as IEnumerable) : null;',
      '                StringBuilder sb = new StringBuilder();',
      '                sb.Append("[");',
      '                bool first = true;',
      '                if (chunks != null)',
      '                {',
      '                    foreach (object cObj in chunks)',
      '                    {',
      '                        string cid = Convert.ToString(cObj);',
      '                        string cRaw;',
      '                        if (nodesMap.TryGetValue(path + ".@" + cid, out cRaw) && cRaw != null && cRaw.Length > 2)',
      '                        {',
      '                            if (!first) sb.Append(",");',
      '                            first = false;',
      '                            sb.Append(cRaw, 1, cRaw.Length - 2);',
      '                        }',
      '                    }',
      '                }',
      '                sb.Append("]");',
      '                return sb.ToString();',
      '            }',
      '            if (kind == "cdc_string")',
      '            {',
      '                IEnumerable chunks = parsed.ContainsKey("chunks") ? (parsed["chunks"] as IEnumerable) : null;',
      '                StringBuilder sb = new StringBuilder();',
      '                if (chunks != null)',
      '                {',
      '                    foreach (object cObj in chunks)',
      '                    {',
      '                        string cid = Convert.ToString(cObj);',
      '                        string cRaw;',
      '                        if (nodesMap.TryGetValue(path + ".@" + cid, out cRaw) && cRaw != null)',
      '                        {',
      '                            sb.Append(cRaw);',
      '                        }',
      '                    }',
      '                }',
      '                return sb.ToString();',
      '            }',
      '            return raw;',
      '        }',
      '',
      '        public Dictionary<string, object> ExportAll(JavaScriptSerializer ser)',
      '        {',
      '            lock (_sync)',
      '            {',
      '                if (HasChunkSave()) return ExportChunkAll(null);',
      '                DateTime t0 = DateTime.UtcNow;',
      '                Dictionary<string, Dictionary<string, string>> nodesByKey = new Dictionary<string, Dictionary<string, string>>();',
      '                Dictionary<string, Dictionary<string, string>> hashesByKey = new Dictionary<string, Dictionary<string, string>>();',
      '                Dictionary<string, string> data = new Dictionary<string, string>();',
      '                long maxUpdatedAt = 0;',
      '                int totalNodes = 0;',
      '',
      '                IntPtr db = GetDb();',
      '                IntPtr nodeStmt;',
      '                PrepareStmt(db, "SELECT root_key, node_path, node_hash, value_json FROM json_nodes;", out nodeStmt);',
      '                try',
      '                {',
      '                    while (WinSqlite3.sqlite3_step(nodeStmt) == WinSqlite3.SQLITE_ROW)',
      '                    {',
      '                        string rk = GetColumnText(nodeStmt, 0) ?? "";',
      '                        string np = GetColumnText(nodeStmt, 1) ?? "";',
      '                        string nh = GetColumnText(nodeStmt, 2) ?? "";',
      '                        string vj = GetColumnText(nodeStmt, 3) ?? "null";',
      '                        Dictionary<string, string> nm;',
      '                        if (!nodesByKey.TryGetValue(rk, out nm))',
      '                        {',
      '                            nm = new Dictionary<string, string>();',
      '                            nodesByKey[rk] = nm;',
      '                            hashesByKey[rk] = new Dictionary<string, string>();',
      '                        }',
      '                        nm[np] = vj;',
      '                        hashesByKey[rk][np] = nh;',
      '                        totalNodes++;',
      '                    }',
      '                }',
      '                finally',
      '                {',
      '                    if (nodeStmt != IntPtr.Zero) WinSqlite3.sqlite3_finalize(nodeStmt);',
      '                }',
      '',
      '                IntPtr kvStmt;',
      '                PrepareStmt(db, "SELECT key, storage_mode, value_text, updated_at FROM kv_store;", out kvStmt);',
      '                try',
      '                {',
      '                    while (WinSqlite3.sqlite3_step(kvStmt) == WinSqlite3.SQLITE_ROW)',
      '                    {',
      '                        string k = GetColumnText(kvStmt, 0) ?? "";',
      '                        string mode = GetColumnText(kvStmt, 1) ?? "inline";',
      '                        string vText = GetColumnText(kvStmt, 2);',
      '                        long upd = WinSqlite3.sqlite3_column_int64(kvStmt, 3);',
      '                        if (upd > maxUpdatedAt) maxUpdatedAt = upd;',
      '                        if (mode == "inline")',
      '                        {',
      '                            data[k] = vText ?? "";',
      '                        }',
      '                        else',
      '                        {',
      '                            Dictionary<string, string> nm;',
      '                            if (nodesByKey.TryGetValue(k, out nm))',
      '                            {',
      '                                data[k] = ReconstructRootKey(nm, ser);',
      '                            }',
      '                        }',
      '                    }',
      '                }',
      '                finally',
      '                {',
      '                    if (kvStmt != IntPtr.Zero) WinSqlite3.sqlite3_finalize(kvStmt);',
      '                }',
      '',
      '                Dictionary<string, object> res = new Dictionary<string, object>();',
      '                res["ok"] = true;',
      '                res["version"] = 22;',
      '                res["backend"] = "winsqlite3-native";',
      '                res["updatedAt"] = maxUpdatedAt;',
      '                res["totalKeys"] = data.Count;',
      '                res["saveCommit"] = GetSaveCommit(ser);',
      '                res["totalNodes"] = totalNodes;',
      '                res["data"] = data;',
      '                res["nodeHashes"] = hashesByKey;',
      '                res["elapsedMs"] = Math.Round((DateTime.UtcNow - t0).TotalMilliseconds, 2);',
      '                return res;',
      '            }',
      '        }',
      '    }',
      '',
      '    public static class Program',
      '    {',
      '        private static SqliteDeltaStore _store;',
      '        private static string _appRoot = ".";',
      '        private static string _endpointPath;',
      '        private static TcpListener _listener;',
      '        private static int _parentPid = 0;',
      '        private static int _shuttingDown = 0;',
      '        private static long _lastActivityTicks = DateTime.UtcNow.Ticks;',
      '',
      '        private static JavaScriptSerializer CreateSerializer()',
      '        {',
      '            JavaScriptSerializer ser = new JavaScriptSerializer();',
      '            ser.MaxJsonLength = int.MaxValue;',
      '            ser.RecursionLimit = 1024;',
      '            return ser;',
      '        }',
      '',
      '        public static void Main(string[] args)',
      '        {',
      '            try { RunMain(args); }',
      '            catch (Exception exc)',
      '            {',
      '                try { File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "startup.log"), DateTime.UtcNow.ToString("o") + " " + exc.ToString() + Environment.NewLine); } catch { }',
      '                Environment.ExitCode = 1;',
      '            }',
      '        }',
      '',
      '        private static void RunMain(string[] args)',
      '        {',
      '            JavaScriptSerializer ser = CreateSerializer();',
      '',
      '            string baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(\'\\\\\', \'/\');',
      '            string appRoot = baseDir;',
      '            try',
      '            {',
      '                DirectoryInfo di = new DirectoryInfo(baseDir);',
      '                if (di.Name.Equals("sqlite", StringComparison.OrdinalIgnoreCase) &&',
      '                    di.Parent != null &&',
      '                    di.Parent.Name.Equals("extensions", StringComparison.OrdinalIgnoreCase) &&',
      '                    di.Parent.Parent != null)',
      '                {',
      '                    appRoot = di.Parent.Parent.FullName;',
      '                }',
      '            }',
      '            catch { }',
      '            for (int i = 0; i < args.Length; i++)',
      '            {',
      '                if (args[i] == "--app-root" && i + 1 < args.Length && !string.IsNullOrEmpty(args[i + 1]))',
      '                {',
      '                    string candidate = args[i + 1].Trim().Trim(\'\\"\').TrimEnd(\'\\\\\', \'/\');',
      '                    if (candidate != "." && candidate != "./" && candidate != ".\\\\")',
      '                    {',
      '                        appRoot = candidate;',
      '                    }',
      '                }',
      '                else if (args[i] == "--parent-pid" && i + 1 < args.Length)',
      '                {',
      '                    int.TryParse(args[i + 1], out _parentPid);',
      '                }',
      '            }',
      '            _appRoot = Path.GetFullPath(appRoot);',
      '            string userdataDir = Path.Combine(_appRoot, "userdata");',
      '            if (!Directory.Exists(userdataDir)) Directory.CreateDirectory(userdataDir);',
      '            string dbPath = Path.Combine(userdataDir, "storage.sqlite");',
      '            _endpointPath = Path.Combine(userdataDir, "sqlite-endpoint.json");',
      '',
      '            try',
      '            {',
      '                if (File.Exists(_endpointPath))',
      '                {',
      '                    Dictionary<string, object> oldEp = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(_endpointPath, Encoding.UTF8));',
      '                    if (oldEp != null && oldEp.ContainsKey("url"))',
      '                    {',
      '                        HttpWebRequest req = (HttpWebRequest)WebRequest.Create(Convert.ToString(oldEp["url"]) + "/shutdown");',
      '                        req.Method = "POST";',
      '                        req.Timeout = 400;',
      '                        req.ContentLength = 0;',
      '                        using (WebResponse resp = req.GetResponse()) { }',
      '                    }',
      '                }',
      '            }',
      '            catch { }',
      '',
      '            _store = new SqliteDeltaStore(dbPath);',
      '',
      '            _listener = new TcpListener(IPAddress.Loopback, 0);',
      '            _listener.Start();',
      '            int httpPort = ((IPEndPoint)_listener.LocalEndpoint).Port;',
      '',
      '            Dictionary<string, object> ep = new Dictionary<string, object>();',
      '            ep["port"] = httpPort;',
      '            ep["url"] = "http://127.0.0.1:" + httpPort;',
      '            ep["pid"] = Process.GetCurrentProcess().Id;',
      '            ep["version"] = 22;',
      '            ep["backend"] = "winsqlite3-native";',
      '            ep["updatedAt"] = DateTime.UtcNow.ToString("o");',
      '            File.WriteAllText(_endpointPath, ser.Serialize(ep), Encoding.UTF8);',
      '',
      '            Thread watchdog = new Thread(WatchParentProcess);',
      '            watchdog.IsBackground = true;',
      '            watchdog.Start();',
      '',
      '            RunHttpLoop(_listener);',
      '        }',
      '',
      '        private static void WatchParentProcess()',
      '        {',
      '            while (true)',
      '            {',
      '                Thread.Sleep(1500);',
      '                if (_parentPid > 0)',
      '                {',
      '                    try',
      '                    {',
      '                        Process p = Process.GetProcessById(_parentPid);',
      '                        if (p == null || p.HasExited)',
      '                        {',
      '                            PerformGracefulShutdown(true);',
      '                            return;',
      '                        }',
      '                    }',
      '                    catch',
      '                    {',
      '                        PerformGracefulShutdown(true);',
      '                        return;',
      '                    }',
      '                }',
      '            }',
      '        }',
      '',
      '        private static void PerformGracefulShutdown(bool deleteSelfBinary)',
      '        {',
      '            if (Interlocked.Exchange(ref _shuttingDown, 1) == 1) return;',
      '            try { if (_store != null) _store.Shutdown(); } catch { }',
      '            try { if (!string.IsNullOrEmpty(_endpointPath) && File.Exists(_endpointPath)) File.Delete(_endpointPath); } catch { }',
      '            try { if (_listener != null) _listener.Stop(); } catch { }',
      '            if (deleteSelfBinary)',
      '            {',
      '                try',
      '                {',
      '                    string selfExe = Process.GetCurrentProcess().MainModule.FileName;',
      '                    string extDir = Path.GetDirectoryName(selfExe);',
      '                    string verTxt = Path.Combine(extDir ?? "", "ext-version.txt");',
      '                    ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 2 >nul & del /f /q \\"" + selfExe + "\\" \\"" + verTxt + "\\" >nul 2>&1");',
      '                    psi.CreateNoWindow = true;',
      '                    psi.UseShellExecute = false;',
      '                    psi.WindowStyle = ProcessWindowStyle.Hidden;',
      '                    Process.Start(psi);',
      '                }',
      '                catch { }',
      '            }',
      '            Environment.Exit(0);',
      '        }',
      '',
      '        private static string GetQueryParam(string rawPath, string paramName)',
      '        {',
      '            if (string.IsNullOrEmpty(rawPath)) return "";',
      '            int qIdx = rawPath.IndexOf(\'?\');',
      '            if (qIdx < 0 || qIdx + 1 >= rawPath.Length) return "";',
      '            string query = rawPath.Substring(qIdx + 1);',
      '            string[] parts = query.Split(\'&\');',
      '            string prefix = paramName + "=";',
      '            for (int i = 0; i < parts.Length; i++)',
      '            {',
      '                if (parts[i].StartsWith(prefix, StringComparison.OrdinalIgnoreCase))',
      '                {',
      '                    string val = parts[i].Substring(prefix.Length);',
      '                    try { return Uri.UnescapeDataString(val); } catch { return val; }',
      '                }',
      '            }',
      '            return "";',
      '        }',
      '',
      '        private static string ResolveAppPath(string rawPath)',
      '        {',
      '            string p = (rawPath ?? "").Trim();',
      '            if (string.IsNullOrEmpty(p) || p == "." || p == "./" || p == ".\\\\") return _appRoot;',
      '            p = p.Replace("/", Path.DirectorySeparatorChar.ToString()).Replace("\\\\", Path.DirectorySeparatorChar.ToString());',
      '            if (Path.IsPathRooted(p)) return Path.GetFullPath(p);',
      '            if (p.StartsWith("." + Path.DirectorySeparatorChar)) p = p.Substring(2);',
      '            return Path.GetFullPath(Path.Combine(_appRoot, p));',
      '        }',
      '',
      '        private static object HandleRpc(string action, Dictionary<string, object> payload, JavaScriptSerializer ser, bool deleteBinaryOnShutdown, bool killParentOnShutdown)',
      '        {',
      '            Interlocked.Exchange(ref _lastActivityTicks, DateTime.UtcNow.Ticks);',
      '            if (action == "ping")',
      '            {',
      '                Dictionary<string, object> r = new Dictionary<string, object>();',
      '                r["ok"] = true;',
      '                r["version"] = 22;',
      '                r["backend"] = "winsqlite3-native";',
      '                return r;',
      '            }',
      '            if (action == "shutdown")',
      '            {',
      '                bool delBin = deleteBinaryOnShutdown || (payload != null && payload.ContainsKey("deleteBinary") && Convert.ToBoolean(payload["deleteBinary"]));',
      '                bool killPar = killParentOnShutdown || (payload != null && payload.ContainsKey("killParent") && Convert.ToBoolean(payload["killParent"]));',
      '                if (_store != null) _store.Shutdown();',
      '                try { if (!string.IsNullOrEmpty(_endpointPath) && File.Exists(_endpointPath)) File.Delete(_endpointPath); } catch { }',
      '                ThreadPool.QueueUserWorkItem(_ => {',
      '                    Thread.Sleep(60);',
      '                    if (killPar && _parentPid > 0) {',
      '                        try { Process p = Process.GetProcessById(_parentPid); if (p != null && !p.HasExited) p.Kill(); } catch { }',
      '                    }',
      '                    PerformGracefulShutdown(delBin);',
      '                });',
      '                Dictionary<string, object> r = new Dictionary<string, object>();',
      '                r["ok"] = true;',
      '                r["shuttingDown"] = true;',
      '                return r;',
      '            }',
      '            if (action == "fsReadFile")',
      '            {',
      '                string target = ResolveAppPath(payload != null && payload.ContainsKey("path") ? Convert.ToString(payload["path"]) : "");',
      '                Dictionary<string, object> r = new Dictionary<string, object>();',
      '                if (!File.Exists(target)) { r["ok"] = false; r["error"] = "File not found: " + target; return r; }',
      '                r["ok"] = true;',
      '                r["data"] = File.ReadAllText(target, Encoding.UTF8);',
      '                return r;',
      '            }',
      '            if (action == "fsWriteFile")',
      '            {',
      '                string target = ResolveAppPath(payload != null && payload.ContainsKey("path") ? Convert.ToString(payload["path"]) : "");',
      '                string content = payload != null && payload.ContainsKey("data") && payload["data"] != null ? Convert.ToString(payload["data"]) : "";',
      '                string dir = Path.GetDirectoryName(target);',
      '                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);',
      '                File.WriteAllText(target, content, new UTF8Encoding(false));',
      '                Dictionary<string, object> r = new Dictionary<string, object>();',
      '                r["ok"] = true;',
      '                return r;',
      '            }',
      '            if (action == "fsAppendFile")',
      '            {',
      '                string target = ResolveAppPath(payload != null && payload.ContainsKey("path") ? Convert.ToString(payload["path"]) : "");',
      '                string content = payload != null && payload.ContainsKey("data") && payload["data"] != null ? Convert.ToString(payload["data"]) : "";',
      '                string dir = Path.GetDirectoryName(target);',
      '                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);',
      '                File.AppendAllText(target, content, new UTF8Encoding(false));',
      '                Dictionary<string, object> r = new Dictionary<string, object>();',
      '                r["ok"] = true;',
      '                return r;',
      '            }',
      '            if (action == "fsGetStats")',
      '            {',
      '                string target = ResolveAppPath(payload != null && payload.ContainsKey("path") ? Convert.ToString(payload["path"]) : "");',
      '                Dictionary<string, object> r = new Dictionary<string, object>();',
      '                if (File.Exists(target))',
      '                {',
      '                    FileInfo fi = new FileInfo(target);',
      '                    r["ok"] = true; r["isFile"] = true; r["isDirectory"] = false; r["size"] = fi.Length;',
      '                    return r;',
      '                }',
      '                if (Directory.Exists(target))',
      '                {',
      '                    r["ok"] = true; r["isFile"] = false; r["isDirectory"] = true; r["size"] = 0;',
      '                    return r;',
      '                }',
      '                r["ok"] = false; r["error"] = "Path not found: " + target;',
      '                return r;',
      '            }',
      '            if (action == "fsCreateDirectory")',
      '            {',
      '                string target = ResolveAppPath(payload != null && payload.ContainsKey("path") ? Convert.ToString(payload["path"]) : "");',
      '                if (!Directory.Exists(target)) Directory.CreateDirectory(target);',
      '                Dictionary<string, object> r = new Dictionary<string, object>();',
      '                r["ok"] = true;',
      '                return r;',
      '            }',
      '            if (action == "fsRemove")',
      '            {',
      '                string target = ResolveAppPath(payload != null && payload.ContainsKey("path") ? Convert.ToString(payload["path"]) : "");',
      '                if (File.Exists(target)) File.Delete(target);',
      '                else if (Directory.Exists(target)) Directory.Delete(target, true);',
      '                Dictionary<string, object> r = new Dictionary<string, object>();',
      '                r["ok"] = true;',
      '                return r;',
      '            }',
      '            if (action == "osExecCommand")',
      '            {',
      '                string cmd = payload != null && payload.ContainsKey("command") ? Convert.ToString(payload["command"]) : "";',
      '                bool bg = payload != null && payload.ContainsKey("background") && Convert.ToBoolean(payload["background"]);',
      '                Dictionary<string, object> r = new Dictionary<string, object>();',
      '                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c " + cmd);',
      '                psi.WorkingDirectory = _appRoot;',
      '                psi.CreateNoWindow = true;',
      '                psi.UseShellExecute = false;',
      '                psi.WindowStyle = ProcessWindowStyle.Hidden;',
      '                if (bg)',
      '                {',
      '                    Process.Start(psi);',
      '                    r["ok"] = true; r["exitCode"] = 0; r["stdOut"] = ""; r["stdErr"] = "";',
      '                    return r;',
      '                }',
      '                psi.RedirectStandardOutput = true;',
      '                psi.RedirectStandardError = true;',
      '                using (Process proc = Process.Start(psi))',
      '                {',
      '                    string stdout = proc.StandardOutput.ReadToEnd();',
      '                    string stderr = proc.StandardError.ReadToEnd();',
      '                    proc.WaitForExit(12000);',
      '                    r["ok"] = true;',
      '                    r["exitCode"] = proc.HasExited ? proc.ExitCode : 0;',
      '                    r["stdOut"] = stdout;',
      '                    r["stdErr"] = stderr;',
      '                }',
      '                return r;',
      '            }',
      '            if (action == "prepareChunkSave") return _store.PrepareChunkSave(payload);',
      '            if (action == "commitChunkSave") return _store.CommitChunkSave(Convert.ToString(payload["id"]));',
      '            if (action == "collectChunks") return _store.CollectChunks();',
      '            if (action == "chunkMeta") return _store.ExportChunkMeta(payload.ContainsKey("id") ? Convert.ToString(payload["id"]) : null);',
      '            if (action == "commitSave") return _store.CommitSave(payload, ser);',
      '            if (action == "applyDelta") return _store.ApplyDelta(payload);',
      '            if (action == "exportMeta") return _store.ExportMeta(ser);',
      '            if (action == "exportAll") return _store.ExportAll(ser);',
      '            Dictionary<string, object> err = new Dictionary<string, object>();',
      '            err["ok"] = false;',
      '            err["error"] = "Unknown action: " + action;',
      '            return err;',
      '        }',
      '',
      '        private static void RunHttpLoop(TcpListener listener)',
      '        {',
      '            while (true)',
      '            {',
      '                try',
      '                {',
      '                    TcpClient client = listener.AcceptTcpClient();',
      '                    ThreadPool.QueueUserWorkItem(_ => HandleHttpClient(client));',
      '                }',
      '                catch { break; }',
      '            }',
      '        }',
      '',
      '        private static int FindHeaderEnd(byte[] buf, int len)',
      '        {',
      '            for (int i = 0; i <= len - 4; i++)',
      '            {',
      '                if (buf[i] == 13 && buf[i + 1] == 10 && buf[i + 2] == 13 && buf[i + 3] == 10)',
      '                {',
      '                    return i + 4;',
      '                }',
      '            }',
      '            return -1;',
      '        }',
      '',
      '        private static void HandleHttpClient(TcpClient client)',
      '        {',
      '            JavaScriptSerializer ser = CreateSerializer();',
      '            client.NoDelay = true;',
      '            client.ReceiveBufferSize = 1048576;',
      '            client.SendBufferSize = 1048576;',
      '            using (client)',
      '            using (NetworkStream ns = client.GetStream())',
      '            {',
      '                try',
      '                {',
      '                    byte[] scratch = new byte[65536];',
      '                    int scratchLen = 0;',
      '                    int headerEnd = -1;',
      '                    while (headerEnd < 0)',
      '                    {',
      '                        if (scratchLen >= scratch.Length) return;',
      '                        int r = ns.Read(scratch, scratchLen, scratch.Length - scratchLen);',
      '                        if (r <= 0) return;',
      '                        scratchLen += r;',
      '                        headerEnd = FindHeaderEnd(scratch, scratchLen);',
      '                    }',
      '                    string headerStr = Encoding.ASCII.GetString(scratch, 0, headerEnd);',
      '                    string[] lines = headerStr.Split(new string[] { "\\r\\n" }, StringSplitOptions.None);',
      '                    if (lines.Length == 0) return;',
      '                    string[] reqParts = lines[0].Split(\' \');',
      '                    string method = reqParts.Length > 0 ? reqParts[0].ToUpperInvariant() : "GET";',
      '                    string path = reqParts.Length > 1 ? reqParts[1] : "/";',
      '',
      '                    if (method == "OPTIONS")',
      '                    {',
      '                        WriteHttpResponse(ns, "{}");',
      '                        return;',
      '                    }',
      '',
      '                    int contentLength = 0;',
      '                    for (int i = 1; i < lines.Length; i++)',
      '                    {',
      '                        if (lines[i].StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))',
      '                        {',
      '                            int.TryParse(lines[i].Substring(15).Trim(), out contentLength);',
      '                        }',
      '                    }',
      '',
      '                    if (path.StartsWith("/chunks") && contentLength > 1048576) throw new Exception("Chunk batch exceeds 1 MiB");',
      '                    byte[] bodyBytes = new byte[0];',
      '                    if (contentLength > 0)',
      '                    {',
      '                        bodyBytes = new byte[contentLength];',
      '                        int alreadyRead = scratchLen - headerEnd;',
      '                        int copyLen = Math.Min(alreadyRead, contentLength);',
      '                        if (copyLen > 0)',
      '                        {',
      '                            Buffer.BlockCopy(scratch, headerEnd, bodyBytes, 0, copyLen);',
      '                        }',
      '                        int readTotal = copyLen;',
      '                        while (readTotal < contentLength)',
      '                        {',
      '                            int r = ns.Read(bodyBytes, readTotal, contentLength - readTotal);',
      '                            if (r <= 0) break;',
      '                            readTotal += r;',
      '                        }',
      '                        if (readTotal < contentLength) return;',
      '                    }',
      '',
      '                    if (path.StartsWith("/get-text") && _store.HasChunkSave()) {',
      '                        string text = _store.ReadChunkValue(GetQueryParam(path, "key"), GetQueryParam(path, "saveId"));',
      '                        var escaped = new StringBuilder("\\""); foreach (char c in text) escaped.Append("\\\\u").Append(((int)c).ToString("x4")); escaped.Append(\'"\');',
      '                        WriteHttpResponse(ns, escaped.ToString()); return;',
      '                    }',
      '                    if (path.StartsWith("/chunks")) { WriteHttpResponse(ns, ser.Serialize(_store.PutChunkBatch(GetQueryParam(path, "id"), bodyBytes))); return; }',
      '                    if (path.StartsWith("/get-raw") && _store.HasChunkSave()) {',
      '                        string generation = GetQueryParam(path, "saveId"); if (generation == "") generation = null;',
      '                        _store.StreamChunkValue(GetQueryParam(path, "key"), generation, (length, codec) => {',
      '                            string headers = "HTTP/1.1 200 OK\\r\\nContent-Type: application/octet-stream\\r\\nAccess-Control-Allow-Origin: *\\r\\nCache-Control: no-store\\r\\nContent-Length: " + length + "\\r\\nConnection: close\\r\\n\\r\\n";',
      '                            byte[] bytes = Encoding.ASCII.GetBytes(headers); ns.Write(bytes, 0, bytes.Length);',
      '                        }, bytes => ns.Write(bytes, 0, bytes.Length)); ns.Flush(); return;',
      '                    }',
      '                    if (path.StartsWith("/get-raw"))',
      '                    {',
      '                        Interlocked.Exchange(ref _lastActivityTicks, DateTime.UtcNow.Ticks);',
      '                        string key = GetQueryParam(path, "key");',
      '                        byte[] rawVal = _store.GetRawValueBytes(key, ser);',
      '                        if (rawVal == null) WriteHttpBytesResponse(ns, "404 Not Found", "text/plain; charset=utf-8", new byte[0]);',
      '                        else WriteHttpBytesResponse(ns, "200 OK", "text/plain; charset=utf-8", rawVal);',
      '                        return;',
      '                    }',
      '',
      '                    if (path.StartsWith("/put-raw"))',
      '                    {',
      '                        Interlocked.Exchange(ref _lastActivityTicks, DateTime.UtcNow.Ticks);',
      '                        string key = GetQueryParam(path, "key");',
      '                        long charLen = 0; long.TryParse(GetQueryParam(path, "charLen"), out charLen);',
      '                        long rev = 1; long.TryParse(GetQueryParam(path, "revision"), out rev);',
      '                        long upd = 0; long.TryParse(GetQueryParam(path, "updatedAt"), out upd);',
      '                        bool cp = GetQueryParam(path, "checkpoint") == "1";',
      '                        object putRes = _store.PutRawValueBytes(key, bodyBytes, charLen, rev, upd, cp);',
      '                        WriteHttpResponse(ns, ser.Serialize(putRes));',
      '                        return;',
      '                    }',
      '',
      '                    object resObj;',
      '                    if (path.StartsWith("/ping")) resObj = HandleRpc("ping", null, ser, false, false);',
      '                    else if (path.StartsWith("/shutdown")) resObj = HandleRpc("shutdown", null, ser, GetQueryParam(path, "deleteBinary") == "1", GetQueryParam(path, "killParent") == "1");',
      '                    else if (path.StartsWith("/export-meta")) resObj = HandleRpc("exportMeta", null, ser, false, false);',
      '                    else if (path.StartsWith("/export-all")) resObj = HandleRpc("exportAll", null, ser, false, false);',
      '                    else',
      '                    {',
      '                        string bodyStr = contentLength > 0 ? Encoding.UTF8.GetString(bodyBytes, 0, contentLength) : "";',
      '                        Dictionary<string, object> req = string.IsNullOrEmpty(bodyStr) ? new Dictionary<string, object>() : ser.Deserialize<Dictionary<string, object>>(bodyStr);',
      '                        string action = (req != null && req.ContainsKey("action")) ? Convert.ToString(req["action"]) : "ping";',
      '                        Dictionary<string, object> payload = (req != null && req.ContainsKey("payload")) ? (req["payload"] as Dictionary<string, object>) : req;',
      '                        resObj = HandleRpc(action, payload, ser, false, false);',
      '                    }',
      '                    WriteHttpResponse(ns, ser.Serialize(resObj));',
      '                }',
      '                catch (Exception ex)',
      '                {',
      '                    Dictionary<string, object> err = new Dictionary<string, object>();',
      '                    err["ok"] = false;',
      '                    err["error"] = ex.Message;',
      '                    try { WriteHttpResponse(ns, ser.Serialize(err)); } catch { }',
      '                }',
      '            }',
      '        }',
      '',
      '        private static void WriteHttpBytesResponse(NetworkStream ns, string statusText, string contentType, byte[] bodyBytes)',
      '        {',
      '            byte[] safeBytes = bodyBytes ?? new byte[0];',
      '            string hdr = "HTTP/1.1 " + statusText + "\\r\\nContent-Type: " + contentType + "\\r\\nAccess-Control-Allow-Origin: *\\r\\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\\r\\nAccess-Control-Allow-Headers: Content-Type, Cache-Control, Pragma, Accept, Authorization, X-Requested-With\\r\\nCache-Control: no-store\\r\\nContent-Length: " + safeBytes.Length + "\\r\\nConnection: close\\r\\n\\r\\n";',
      '            byte[] hdrBytes = Encoding.ASCII.GetBytes(hdr);',
      '            ns.Write(hdrBytes, 0, hdrBytes.Length);',
      '            if (safeBytes.Length > 0) ns.Write(safeBytes, 0, safeBytes.Length);',
      '            ns.Flush();',
      '        }',
      '',
      '        private static void WriteHttpResponse(NetworkStream ns, string jsonBody)',
      '        {',
      '            byte[] bodyBytes = Encoding.UTF8.GetBytes(SqliteDeltaStore.EscapeJsonSurrogates(jsonBody ?? "{}"));',
      '            WriteHttpBytesResponse(ns, "200 OK", "application/json; charset=utf-8", bodyBytes);',
      '        }',
      '    }',
      '}',
      '',
      '// BEGIN CHUNK STORE',
      'namespace NeutralinoSqliteExtension',
      '{',
      '    using System;',
      '    using System.Collections;',
      '    using System.Collections.Generic;',
      '    using System.IO;',
      '    using System.Text;',
      '    using System.Runtime.InteropServices;',
      '    using System.Web.Script.Serialization;',
      '',
      '    public sealed partial class SqliteDeltaStore',
      '    {',
      '        private readonly HashSet<string> _checkedChunks = new HashSet<string>();',
      '        private readonly HashSet<string> _checkedValues = new HashSet<string>();',
      '        private readonly Dictionary<string, int> _chunkReadPins = new Dictionary<string, int>();',
      '        private void ChunkSchema()',
      '        {',
      '            ExecSql(GetDb(), "CREATE TABLE IF NOT EXISTS chunk_blobs (hash TEXT PRIMARY KEY, data BLOB NOT NULL, created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS chunk_values (root TEXT PRIMARY KEY, manifest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS chunk_saves (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS chunk_uploads (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL);");',
      '        }',
      '        private void ChunkExec(string sql, params object[] values)',
      '        {',
      '            IntPtr stmt; PrepareStmt(GetDb(), sql, out stmt);',
      '            try { ChunkBind(stmt, values); StepDone(stmt, "chunkWrite"); }',
      '            finally { WinSqlite3.sqlite3_finalize(stmt); }',
      '        }',
      '        private void ChunkBind(IntPtr stmt, object[] values)',
      '        {',
      '            for (int i = 0; i < values.Length; i++)',
      '            {',
      '                var bytes = values[i] as byte[];',
      '                if (bytes != null) { if (WinSqlite3.sqlite3_bind_blob(stmt, i + 1, bytes, bytes.Length, WinSqlite3.SQLITE_TRANSIENT) != 0) throw new Exception("Chunk bind failed"); }',
      '                else BindText(stmt, i + 1, Convert.ToString(values[i]));',
      '            }',
      '        }',
      '        private string ChunkText(string sql, params object[] values)',
      '        {',
      '            IntPtr stmt; PrepareStmt(GetDb(), sql, out stmt);',
      '            try { ChunkBind(stmt, values); int rc = WinSqlite3.sqlite3_step(stmt); if (rc == WinSqlite3.SQLITE_DONE) return null; if (rc != WinSqlite3.SQLITE_ROW) throw new Exception("Chunk query failed"); return GetColumnText(stmt, 0); }',
      '            finally { WinSqlite3.sqlite3_finalize(stmt); }',
      '        }',
      '        private byte[] ChunkBytes(string hash)',
      '        {',
      '            IntPtr stmt; PrepareStmt(GetDb(), "SELECT data FROM chunk_blobs WHERE hash = ?", out stmt);',
      '            try {',
      '                BindText(stmt, 1, hash); if (WinSqlite3.sqlite3_step(stmt) != WinSqlite3.SQLITE_ROW) throw new Exception("Missing chunk: " + hash);',
      '                int size = WinSqlite3.sqlite3_column_bytes(stmt, 0); byte[] bytes = new byte[size];',
      '                if (size > 0) Marshal.Copy(WinSqlite3.sqlite3_column_blob(stmt, 0), bytes, 0, size);',
      '                if (!_checkedChunks.Contains(hash)) { if (ChunkHash(bytes) != hash) throw new Exception("Chunk SHA-256 mismatch"); _checkedChunks.Add(hash); }',
      '                return bytes;',
      '            } finally { WinSqlite3.sqlite3_finalize(stmt); }',
      '        }',
      '        private static string ChunkHash(byte[] bytes)',
      '        {',
      '            using (var sha = System.Security.Cryptography.SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();',
      '        }',
      '        private static Dictionary<string, object> ChunkObject(object value) { return (Dictionary<string, object>)value; }',
      '        private static JavaScriptSerializer ChunkSerializer() { return new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 1024 }; }',
      '        public bool HasChunkSave() { return ChunkText("SELECT meta_value FROM storage_meta WHERE meta_key = \'chunk_active\'") != null; }',
      '        private string CurrentSaveId()',
      '        {',
      '            string active = ChunkText("SELECT meta_value FROM storage_meta WHERE meta_key = \'chunk_active\'");',
      '            if (active != null) return active;',
      '            var prior = ReadSaveCommit(ChunkSerializer()); return prior == null ? "" : Convert.ToString(prior["id"]);',
      '        }',
      '        private Dictionary<string, object> ChunkSave(string id)',
      '        {',
      '            string raw = ChunkText("SELECT metadata FROM chunk_saves WHERE id = ?", id ?? CurrentSaveId());',
      '            if (raw == null) throw new Exception("Save generation unavailable");',
      '            var save = ChunkSerializer().Deserialize<Dictionary<string, object>>(raw);',
      '            var payload = new Dictionary<string, object>(save); payload["entries"] = save["hashes"];',
      '            if (Convert.ToString(save["rootHash"]) != SnapshotHash(payload) || Convert.ToInt32(save["keyCount"]) != ChunkObject(save["hashes"]).Count) throw new Exception("Save root SHA-256 mismatch");',
      '            return save;',
      '        }',
      '        private Dictionary<string, object> ChunkManifest(string root)',
      '        {',
      '            string raw = ChunkText("SELECT manifest FROM chunk_values WHERE root = ?", root);',
      '            if (raw == null) throw new Exception("Missing value manifest");',
      '            var manifest = ChunkSerializer().Deserialize<Dictionary<string, object>>(raw);',
      '            if (Convert.ToString(manifest["root"]) != root) throw new Exception("Value root reference mismatch");',
      '            return manifest;',
      '        }',
      '        private void ValidateManifest(Dictionary<string, object> m, bool contents)',
      '        {',
      '            string encoding = Convert.ToString(m["encoding"]);',
      '            if (encoding != "utf8" && encoding != "utf16le") throw new Exception("Unknown chunk encoding");',
      '            long length = Convert.ToInt64(m["bytes"]), chars = Convert.ToInt64(m["chars"]);',
      '            if (length < 0 || chars < 0) throw new Exception("Invalid value length");',
      '            string canonical;',
      '            if (m.ContainsKey("inline")) {',
      '                string text = Convert.ToString(m["inline"]);',
      '                if (encoding != "utf8" || Encoding.UTF8.GetByteCount(text) != length || text.Length != chars || length > 65536) throw new Exception("Invalid inline value");',
      '                canonical = "22\\ninline\\n" + text;',
      '            } else {',
      '                var text = new StringBuilder("22\\n" + encoding + "\\n" + chars + "\\n" + length + "\\n"); long total = 0;',
      '                foreach (object item in (IEnumerable)m["chunks"]) {',
      '                    var c = ChunkObject(item); string hash = Convert.ToString(c["hash"]); int count = Convert.ToInt32(c["bytes"]);',
      '                    if (hash.Length != 64 || count <= 0 || count > 524288) throw new Exception("Invalid chunk descriptor");',
      '                    total += count; text.Append(hash).Append(\':\').Append(count).Append(\'\\n\');',
      '                    if (contents) { string storedLength = ChunkText("SELECT length(data) FROM chunk_blobs WHERE hash = ?", hash); if (storedLength == null || Convert.ToInt32(storedLength) != count) throw new Exception("Missing chunk"); if (!_checkedChunks.Contains(hash)) ChunkBytes(hash); }',
      '                }',
      '                if (total != length || encoding == "utf16le" && length != chars * 2) throw new Exception("Value length mismatch"); canonical = text.ToString();',
      '            }',
      '            if (ChunkHash(Encoding.UTF8.GetBytes(canonical)) != Convert.ToString(m["root"])) throw new Exception("Manifest SHA-256 mismatch");',
      '            if (contents && !m.ContainsKey("inline") && !_checkedValues.Contains(Convert.ToString(m["root"]))) {',
      '                long count = 0;',
      '                if (encoding == "utf8") {',
      '                    var decoder = new UTF8Encoding(false, true).GetDecoder();',
      '                    var charBuffer = new char[524290];',
      '                    foreach (object item in (IEnumerable)m["chunks"]) { byte[] bytes = ChunkBytes(Convert.ToString(ChunkObject(item)["hash"])); count += decoder.GetChars(bytes, 0, bytes.Length, charBuffer, 0, false); }',
      '                    count += decoder.GetChars(new byte[0], 0, 0, charBuffer, 0, true);',
      '                } else count = length / 2;',
      '                if (count != chars) throw new Exception("Character length mismatch");',
      '                _checkedValues.Add(Convert.ToString(m["root"]));',
      '            }',
      '        }',
      '        private static string SnapshotHash(Dictionary<string, object> p)',
      '        {',
      '            var entries = ChunkObject(p["entries"]); var keys = new List<string>(entries.Keys); keys.Sort(StringComparer.Ordinal);',
      '            var text = new StringBuilder("22-save\\n" + p["id"] + "\\n" + p["baseId"] + "\\n" + p["revision"] + "\\n" + p["updatedAt"] + "\\n" + p["legacyUpdatedAt"] + "\\n");',
      '            foreach (string key in keys) text.Append(key.Length).Append(\':\').Append(key).Append(\':\').Append(entries[key]).Append(\'\\n\');',
      '            return ChunkHash(Encoding.UTF8.GetBytes(text.ToString()));',
      '        }',
      '        public Dictionary<string, object> PrepareChunkSave(Dictionary<string, object> payload)',
      '        {',
      '            lock (_sync) {',
      '                ChunkSchema(); var ser = ChunkSerializer(); string id = Convert.ToString(payload["id"]);',
      '                if (!payload.ContainsKey("rootHash") || Convert.ToString(payload["rootHash"]) != SnapshotHash(payload)) throw new Exception("Save root SHA-256 mismatch");',
      '                if (string.IsNullOrEmpty(id) || CurrentSaveId() != Convert.ToString(payload["baseId"])) throw new Exception("Save conflict: reload the current save");',
      '                var missing = new HashSet<string>();',
      '                foreach (object item in (IEnumerable)payload["manifests"]) {',
      '                    var m = ChunkObject(item); ValidateManifest(m, false);',
      '                    string root = Convert.ToString(m["root"]), raw = ser.Serialize(m);',
      '                    ChunkExec("INSERT OR IGNORE INTO chunk_values(root,manifest) VALUES(?,?)", root, raw);',
      '                }',
      '                foreach (var entry in ChunkObject(payload["entries"])) {',
      '                    var m = ChunkManifest(Convert.ToString(entry.Value)); ValidateManifest(m, false);',
      '                    foreach (object item in (IEnumerable)m["chunks"]) { var c = ChunkObject(item); string hash = Convert.ToString(c["hash"]); if (ChunkText("SELECT hash FROM chunk_blobs WHERE hash = ?", hash) == null) missing.Add(hash); }',
      '                }',
      '                string previous = ChunkText("SELECT payload FROM chunk_uploads WHERE id = ?", id), json = ser.Serialize(payload);',
      '                if (previous != null && previous != json) throw new Exception("Upload id already used");',
      '                ChunkExec("INSERT OR IGNORE INTO chunk_uploads(id,payload,created_at) VALUES(?,?,?)", id, json, NowMs());',
      '                return new Dictionary<string, object> { {"ok", true}, {"missing", new List<string>(missing)} };',
      '            }',
      '        }',
      '        public Dictionary<string, object> PutChunkBatch(string id, byte[] body)',
      '        {',
      '            if (body.Length < 4 || body.Length > 1048576) throw new Exception("Invalid chunk batch size");',
      '            lock (_sync) {',
      '                ChunkSchema(); if (ChunkText("SELECT id FROM chunk_uploads WHERE id = ?", id) == null) throw new Exception("Upload expired");',
      '                int count = BitConverter.ToInt32(body, 0), offset = 4;',
      '                if (count < 0 || count > 64) throw new Exception("Invalid chunk count");',
      '                ExecSql(GetDb(), "BEGIN IMMEDIATE");',
      '                try {',
      '                    for (int i = 0; i < count; i++) {',
      '                        if (offset + 36 > body.Length) throw new Exception("Truncated chunk batch");',
      '                        string hash = BitConverter.ToString(body, offset, 32).Replace("-", "").ToLowerInvariant(); int size = BitConverter.ToInt32(body, offset + 32); offset += 36;',
      '                        if (size <= 0 || size > 524288 || size > body.Length - offset) throw new Exception("Invalid chunk size");',
      '                        byte[] bytes = new byte[size]; Buffer.BlockCopy(body, offset, bytes, 0, size); offset += size;',
      '                        if (ChunkHash(bytes) != hash) throw new Exception("Chunk SHA-256 mismatch");',
      '                        ChunkExec("INSERT OR IGNORE INTO chunk_blobs(hash,data,created_at) VALUES(?,?,?)", hash, bytes, NowMs());',
      '                        _checkedChunks.Remove(hash); ChunkBytes(hash);',
      '                    }',
      '                    if (offset != body.Length) throw new Exception("Trailing chunk batch bytes"); ExecSql(GetDb(), "COMMIT");',
      '                } catch { ExecSql(GetDb(), "ROLLBACK"); _checkedChunks.Clear(); throw; }',
      '                return new Dictionary<string, object> { {"ok", true}, {"bytes", body.Length} };',
      '            }',
      '        }',
      '        public Dictionary<string, object> CommitChunkSave(string id)',
      '        {',
      '            lock (_sync) {',
      '                ChunkSchema(); if (HasChunkSave() && CurrentSaveId() == id) return new Dictionary<string, object> { {"ok", true}, {"commit", ChunkSave(id)} };',
      '                string raw = ChunkText("SELECT payload FROM chunk_uploads WHERE id = ?", id); if (raw == null) throw new Exception("Upload expired");',
      '                var p = ChunkSerializer().Deserialize<Dictionary<string, object>>(raw); var entries = ChunkObject(p["entries"]);',
      '                ExecSql(GetDb(), "BEGIN IMMEDIATE");',
      '                try {',
      '                    if (CurrentSaveId() != Convert.ToString(p["baseId"])) throw new Exception("Save conflict: reload the current save");',
      '                    foreach (var pair in entries) ValidateManifest(ChunkManifest(Convert.ToString(pair.Value)), true);',
      '                    var commit = new Dictionary<string, object> { {"id", id}, {"format", 22}, {"baseId", p["baseId"]}, {"rootHash", p["rootHash"]}, {"revision", p["revision"]}, {"updatedAt", p["updatedAt"]}, {"legacyUpdatedAt", p["legacyUpdatedAt"]}, {"hashes", entries}, {"keyCount", entries.Count}, {"verified", true} };',
      '                    ChunkExec("INSERT INTO chunk_saves(id,metadata,created_at) VALUES(?,?,?)", id, ChunkSerializer().Serialize(commit), NowMs());',
      '                    ChunkExec("INSERT OR REPLACE INTO storage_meta(meta_key,meta_value,updated_at) VALUES(\'chunk_active\',?,?)", id, NowMs());',
      '                    ChunkExec("DELETE FROM chunk_uploads WHERE id = ?", id); ExecSql(GetDb(), "COMMIT");',
      '                    return new Dictionary<string, object> { {"ok", true}, {"commit", commit} };',
      '                } catch { ExecSql(GetDb(), "ROLLBACK"); throw; }',
      '            }',
      '        }',
      '        public Dictionary<string, object> ExportChunkMeta(string id)',
      '        {',
      '            lock (_sync) {',
      '                var commit = ChunkSave(id); var values = new Dictionary<string, object>(); var small = new Dictionary<string, string>(); var large = new List<string>();',
      '                foreach (var entry in ChunkObject(commit["hashes"])) { var m = ChunkManifest(Convert.ToString(entry.Value)); ValidateManifest(m, false); values[entry.Key] = m; if (m.ContainsKey("inline")) small[entry.Key] = Convert.ToString(m["inline"]); else large.Add(entry.Key); }',
      '                return new Dictionary<string, object> { {"ok", true}, {"version", 22}, {"format", 22}, {"backend", "winsqlite3-native"}, {"saveCommit", commit}, {"totalKeys", values.Count}, {"updatedAt", commit["updatedAt"]}, {"values", values}, {"inlineData", small}, {"largeKeys", large} };',
      '            }',
      '        }',
      '        public void StreamChunkValue(string key, string id, Action<long, string> header, Action<byte[]> write)',
      '        {',
      '            Dictionary<string, object> manifest; string saveId;',
      '            lock (_sync) { var save = ChunkSave(id); saveId = Convert.ToString(save["id"]); var entries = ChunkObject(save["hashes"]); if (!entries.ContainsKey(key)) throw new Exception("Key not found"); manifest = ChunkManifest(Convert.ToString(entries[key])); ValidateManifest(manifest, true); if (!_chunkReadPins.ContainsKey(saveId)) _chunkReadPins[saveId] = 0; _chunkReadPins[saveId]++; }',
      '            try {',
      '                header(Convert.ToInt64(manifest["bytes"]), Convert.ToString(manifest["encoding"]));',
      '                if (manifest.ContainsKey("inline")) write(Encoding.UTF8.GetBytes(Convert.ToString(manifest["inline"])));',
      '                else foreach (object item in (IEnumerable)manifest["chunks"]) { byte[] bytes; lock (_sync) { bytes = ChunkBytes(Convert.ToString(ChunkObject(item)["hash"])); } write(bytes); }',
      '            } finally { lock (_sync) { if (--_chunkReadPins[saveId] == 0) _chunkReadPins.Remove(saveId); } }',
      '        }',
      '        public string ReadChunkValue(string key, string id)',
      '        {',
      '            using (var output = new MemoryStream()) { string encoding = "utf8"; StreamChunkValue(key, id, (length, codec) => { encoding = codec; }, bytes => output.Write(bytes, 0, bytes.Length));',
      '                byte[] data = output.ToArray(); if (encoding == "utf8") return new UTF8Encoding(false, true).GetString(data);',
      '                char[] chars = new char[data.Length / 2]; for (int i = 0; i < chars.Length; i++) chars[i] = (char)(data[i * 2] | data[i * 2 + 1] << 8); return new string(chars); }',
      '        }',
      '        public Dictionary<string, object> ExportChunkAll(string id)',
      '        {',
      '            lock (_sync) { var meta = ExportChunkMeta(id); string saveId = Convert.ToString(ChunkObject(meta["saveCommit"])["id"]); var data = new Dictionary<string, string>(); foreach (var key in ChunkObject(ChunkObject(meta["saveCommit"])["hashes"]).Keys) data[key] = ReadChunkValue(key, saveId); meta["data"] = data; return meta; }',
      '        }',
      '        public Dictionary<string, object> CollectChunks()',
      '        {',
      '            lock (_sync) {',
      '                ChunkSchema(); long cutoff = NowMs() - 86400000;',
      '                ChunkExec("DELETE FROM chunk_uploads WHERE created_at < ?", cutoff);',
      '                var keepRoots = new HashSet<string>(); var keepChunks = new HashSet<string>();',
      '                var ids = new List<string>(); IntPtr stmt; PrepareStmt(GetDb(), "SELECT id FROM chunk_saves ORDER BY created_at DESC", out stmt);',
      '                try { while (WinSqlite3.sqlite3_step(stmt) == WinSqlite3.SQLITE_ROW) ids.Add(GetColumnText(stmt, 0)); } finally { WinSqlite3.sqlite3_finalize(stmt); }',
      '                for (int i = 0; i < ids.Count; i++) { if (i < 2 || ids[i] == CurrentSaveId() || _chunkReadPins.ContainsKey(ids[i]) || Convert.ToInt64(ChunkText("SELECT created_at FROM chunk_saves WHERE id = ?", ids[i])) > NowMs() - 120000) { foreach (var pair in ChunkObject(ChunkSave(ids[i])["hashes"])) keepRoots.Add(Convert.ToString(pair.Value)); } else ChunkExec("DELETE FROM chunk_saves WHERE id = ?", ids[i]); }',
      '                PrepareStmt(GetDb(), "SELECT payload FROM chunk_uploads", out stmt);',
      '                try { while (WinSqlite3.sqlite3_step(stmt) == WinSqlite3.SQLITE_ROW) foreach (var pair in ChunkObject(ChunkSerializer().Deserialize<Dictionary<string, object>>(GetColumnText(stmt, 0))["entries"])) keepRoots.Add(Convert.ToString(pair.Value)); } finally { WinSqlite3.sqlite3_finalize(stmt); }',
      '                foreach (string root in keepRoots) foreach (object item in (IEnumerable)ChunkManifest(root)["chunks"]) keepChunks.Add(Convert.ToString(ChunkObject(item)["hash"]));',
      '                var remove = new List<string>(); PrepareStmt(GetDb(), "SELECT hash FROM chunk_blobs", out stmt);',
      '                try { while (WinSqlite3.sqlite3_step(stmt) == WinSqlite3.SQLITE_ROW) { string hash = GetColumnText(stmt, 0); if (!keepChunks.Contains(hash)) remove.Add(hash); } } finally { WinSqlite3.sqlite3_finalize(stmt); }',
      '                var removeValues = new List<string>(); PrepareStmt(GetDb(), "SELECT root FROM chunk_values", out stmt);',
      '                try { while (WinSqlite3.sqlite3_step(stmt) == WinSqlite3.SQLITE_ROW) { string value = GetColumnText(stmt, 0); if (!keepRoots.Contains(value)) removeValues.Add(value); } } finally { WinSqlite3.sqlite3_finalize(stmt); }',
      '                ExecSql(GetDb(), "BEGIN IMMEDIATE"); try { foreach (string hash in remove) { ChunkExec("DELETE FROM chunk_blobs WHERE hash = ?", hash); _checkedChunks.Remove(hash); } foreach (string value in removeValues) { ChunkExec("DELETE FROM chunk_values WHERE root = ?", value); _checkedValues.Remove(value); } ExecSql(GetDb(), "COMMIT"); } catch { ExecSql(GetDb(), "ROLLBACK"); throw; }',
      '                return new Dictionary<string, object> { {"ok", true}, {"removedChunks", remove.Count} };',
      '            }',
      '        }',
      '        public static string EscapeJsonSurrogates(string json)',
      '        {',
      '            var output = new StringBuilder(json.Length);',
      '            foreach (char c in json) { if (char.IsSurrogate(c)) output.Append("\\\\u").Append(((int)c).ToString("x4")); else output.Append(c); }',
      '            return output.ToString();',
      '        }',
      '    }',
      '}',
    ].join("\r\n");

    const pythonSource = [
      '#!/usr/bin/env python3',
      '# -*- coding: utf-8 -*-',
      'import hashlib, sqlite3, json, time, os, sys, threading, urllib.request, urllib.parse',
      'from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer',
      '',
      'SENTINEL = "__NEU_SQLITE_NODE_V9__"',
      '',
      'def escape_path_seg(k):',
      '    return str(k).replace("~", "~0").replace(".", "~1").replace("@", "~2")',
      '',
      '# BEGIN CHUNK STORE',
      'class ChunkStoreMixin:',
      '    def _chunk_schema(self):',
      '        self.conn.executescript("CREATE TABLE IF NOT EXISTS chunk_blobs(hash TEXT PRIMARY KEY,data BLOB NOT NULL,created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS chunk_values(root TEXT PRIMARY KEY,manifest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS chunk_saves(id TEXT PRIMARY KEY,metadata TEXT NOT NULL,created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS chunk_uploads(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at INTEGER NOT NULL);")',
      '        if not hasattr(self, \'_checked_chunks\'): self._checked_chunks, self._checked_values, self._chunk_pins = set(), set(), {}',
      '',
      '    def has_chunk_save(self):',
      '        return self.conn.execute("SELECT meta_value FROM storage_meta WHERE meta_key=\'chunk_active\'").fetchone() is not None',
      '',
      '    def _chunk_current_id(self):',
      '        row = self.conn.execute("SELECT meta_value FROM storage_meta WHERE meta_key=\'chunk_active\'").fetchone()',
      '        return row[0] if row else (self._read_commit() or {}).get(\'id\', \'\')',
      '',
      '    def _chunk_save(self, save_id=None):',
      '        row = self.conn.execute(\'SELECT metadata FROM chunk_saves WHERE id=?\', (save_id or self._chunk_current_id(),)).fetchone()',
      '        if row is None: raise ValueError(\'Save generation unavailable\')',
      '        save = json.loads(row[0])',
      '        if save[\'rootHash\'] != self._snapshot_hash(dict(save, entries=save[\'hashes\'])) or save[\'keyCount\'] != len(save[\'hashes\']): raise ValueError(\'Save root SHA-256 mismatch\')',
      '        return save',
      '',
      '    @staticmethod',
      '    def _snapshot_hash(p):',
      '        canonical = \'22-save\\n%s\\n%s\\n%d\\n%d\\n%d\\n\' % (p[\'id\'],p[\'baseId\'],p[\'revision\'],p[\'updatedAt\'],p[\'legacyUpdatedAt\'])',
      '        for key in sorted(p[\'entries\'], key=lambda value: value.encode(\'utf-16-be\',errors=\'surrogatepass\')):',
      '            canonical += \'%d:%s:%s\\n\' % (len(key.encode(\'utf-16-le\',errors=\'surrogatepass\'))//2,key,p[\'entries\'][key])',
      '        return hashlib.sha256(canonical.encode()).hexdigest()',
      '',
      '    def _chunk_manifest(self, root):',
      '        row = self.conn.execute(\'SELECT manifest FROM chunk_values WHERE root=?\', (root,)).fetchone()',
      '        if row is None: raise ValueError(\'Missing value manifest\')',
      '        manifest = json.loads(row[0])',
      '        if manifest[\'root\'] != root: raise ValueError(\'Value root reference mismatch\')',
      '        return manifest',
      '',
      '    def _chunk_bytes(self, sha):',
      '        row = self.conn.execute(\'SELECT data FROM chunk_blobs WHERE hash=?\', (sha,)).fetchone()',
      '        if row is None: raise ValueError(\'Missing chunk\')',
      '        data = row[0]',
      '        if sha not in self._checked_chunks:',
      '            if hashlib.sha256(data).hexdigest() != sha: raise ValueError(\'Chunk SHA-256 mismatch\')',
      '            self._checked_chunks.add(sha)',
      '        return data',
      '',
      '    def _chunk_validate(self, manifest, contents=False):',
      '        codec, length, chars = manifest[\'encoding\'], int(manifest[\'bytes\']), int(manifest[\'chars\'])',
      '        if codec not in (\'utf8\', \'utf16le\') or length < 0 or chars < 0: raise ValueError(\'Invalid encoding or length\')',
      '        if \'inline\' in manifest:',
      '            text = manifest[\'inline\']',
      '            if codec != \'utf8\' or len(text.encode()) != length or len(text.encode(\'utf-16-le\')) // 2 != chars or length > 65536: raise ValueError(\'Invalid inline value\')',
      '            canonical = \'22\\ninline\\n\' + text',
      '        else:',
      '            canonical = \'22\\n%s\\n%d\\n%d\\n\' % (codec, chars, length)',
      '            total = 0',
      '            for chunk in manifest[\'chunks\']:',
      '                size, sha = int(chunk[\'bytes\']), chunk[\'hash\']',
      '                if len(sha) != 64 or size <= 0 or size > 524288: raise ValueError(\'Invalid chunk descriptor\')',
      '                total += size',
      '                canonical += \'%s:%d\\n\' % (sha, size)',
      '                if contents:',
      '                    row = self.conn.execute(\'SELECT length(data) FROM chunk_blobs WHERE hash=?\', (sha,)).fetchone()',
      '                    if row is None or row[0] != size: raise ValueError(\'Missing chunk\')',
      '                    if sha not in self._checked_chunks: self._chunk_bytes(sha)',
      '            if total != length or codec == \'utf16le\' and length != chars * 2: raise ValueError(\'Value length mismatch\')',
      '        if hashlib.sha256(canonical.encode()).hexdigest() != manifest[\'root\']: raise ValueError(\'Manifest SHA-256 mismatch\')',
      '        if contents and \'inline\' not in manifest and manifest[\'root\'] not in self._checked_values:',
      '            if codec == \'utf8\':',
      '                import codecs',
      '                decoder = codecs.getincrementaldecoder(\'utf-8\')(\'strict\')',
      '                count = 0',
      '                for chunk in manifest[\'chunks\']: count += len(decoder.decode(self._chunk_bytes(chunk[\'hash\'])).encode(\'utf-16-le\')) // 2',
      '                count += len(decoder.decode(b\'\', final=True).encode(\'utf-16-le\')) // 2',
      '            else: count = length // 2',
      '            if count != chars: raise ValueError(\'Character length mismatch\')',
      '            self._checked_values.add(manifest[\'root\'])',
      '',
      '    def prepare_chunk_save(self, payload):',
      '        with self.lock:',
      '            self._chunk_schema()',
      '            if payload.get(\'rootHash\') != self._snapshot_hash(payload): raise ValueError(\'Save root SHA-256 mismatch\')',
      '            if not payload.get(\'id\') or self._chunk_current_id() != payload[\'baseId\']: raise ValueError(\'Save conflict: reload the current save\')',
      '            missing = set()',
      '            with self.conn:',
      '                for manifest in payload[\'manifests\']:',
      '                    self._chunk_validate(manifest)',
      '                    self.conn.execute(\'INSERT OR IGNORE INTO chunk_values(root,manifest) VALUES(?,?)\', (manifest[\'root\'], json.dumps(manifest, ensure_ascii=True)))',
      '                for root in payload[\'entries\'].values():',
      '                    manifest = self._chunk_manifest(root)',
      '                    self._chunk_validate(manifest)',
      '                    for chunk in manifest[\'chunks\']:',
      '                        if self.conn.execute(\'SELECT hash FROM chunk_blobs WHERE hash=?\', (chunk[\'hash\'],)).fetchone() is None: missing.add(chunk[\'hash\'])',
      '                previous = self.conn.execute(\'SELECT payload FROM chunk_uploads WHERE id=?\', (payload[\'id\'],)).fetchone()',
      '                raw = json.dumps(payload, ensure_ascii=True)',
      '                if previous and previous[0] != raw: raise ValueError(\'Upload id already used\')',
      '                self.conn.execute(\'INSERT OR IGNORE INTO chunk_uploads(id,payload,created_at) VALUES(?,?,?)\', (payload[\'id\'], raw, int(time.time()*1000)))',
      '            return dict(ok=True, missing=sorted(missing))',
      '',
      '    def put_chunk_batch(self, upload_id, body):',
      '        import struct',
      '        if len(body) < 4 or len(body) > 1048576: raise ValueError(\'Invalid chunk batch size\')',
      '        with self.lock:',
      '            self._chunk_schema()',
      '            if self.conn.execute(\'SELECT id FROM chunk_uploads WHERE id=?\', (upload_id,)).fetchone() is None: raise ValueError(\'Upload expired\')',
      '            count, offset = struct.unpack_from(\'<I\', body)[0], 4',
      '            if count > 64: raise ValueError(\'Invalid chunk count\')',
      '            try:',
      '                with self.conn:',
      '                    for _ in range(count):',
      '                        if offset + 36 > len(body): raise ValueError(\'Truncated chunk batch\')',
      '                        sha, size = body[offset:offset+32].hex(), struct.unpack_from(\'<I\', body, offset+32)[0]',
      '                        offset += 36',
      '                        if size <= 0 or size > 524288 or offset + size > len(body): raise ValueError(\'Invalid chunk size\')',
      '                        data = body[offset:offset+size]; offset += size',
      '                        if hashlib.sha256(data).hexdigest() != sha: raise ValueError(\'Chunk SHA-256 mismatch\')',
      '                        self.conn.execute(\'INSERT OR IGNORE INTO chunk_blobs(hash,data,created_at) VALUES(?,?,?)\', (sha, data, int(time.time()*1000)))',
      '                        self._checked_chunks.discard(sha); self._chunk_bytes(sha)',
      '                    if offset != len(body): raise ValueError(\'Trailing chunk batch bytes\')',
      '            except Exception:',
      '                self._checked_chunks.clear()',
      '                raise',
      '            return dict(ok=True, bytes=len(body))',
      '',
      '    def commit_chunk_save(self, upload_id):',
      '        with self.lock:',
      '            self._chunk_schema()',
      '            if self.has_chunk_save() and self._chunk_current_id() == upload_id: return dict(ok=True, commit=self._chunk_save(upload_id))',
      '            row = self.conn.execute(\'SELECT payload FROM chunk_uploads WHERE id=?\', (upload_id,)).fetchone()',
      '            if row is None: raise ValueError(\'Upload expired\')',
      '            payload = json.loads(row[0])',
      '            self.conn.execute(\'BEGIN IMMEDIATE\')',
      '            try:',
      '                if self._chunk_current_id() != payload[\'baseId\']: raise ValueError(\'Save conflict: reload the current save\')',
      '                for root in payload[\'entries\'].values(): self._chunk_validate(self._chunk_manifest(root), True)',
      '                commit = dict(id=upload_id, format=22, baseId=payload[\'baseId\'], rootHash=payload[\'rootHash\'], revision=payload[\'revision\'], updatedAt=payload[\'updatedAt\'], legacyUpdatedAt=payload[\'legacyUpdatedAt\'], hashes=payload[\'entries\'], keyCount=len(payload[\'entries\']), verified=True)',
      '                self.conn.execute(\'INSERT INTO chunk_saves(id,metadata,created_at) VALUES(?,?,?)\', (upload_id, json.dumps(commit, ensure_ascii=True), int(time.time()*1000)))',
      '                self.conn.execute("INSERT OR REPLACE INTO storage_meta(meta_key,meta_value,updated_at) VALUES(\'chunk_active\',?,?)", (upload_id, int(time.time()*1000)))',
      '                self.conn.execute(\'DELETE FROM chunk_uploads WHERE id=?\', (upload_id,))',
      '                self.conn.commit()',
      '            except Exception:',
      '                self.conn.rollback(); raise',
      '            return dict(ok=True, commit=commit)',
      '',
      '    def export_chunk_meta(self, save_id=None):',
      '        with self.lock:',
      '            commit = self._chunk_save(save_id)',
      '            values = {key: self._chunk_manifest(root) for key, root in commit[\'hashes\'].items()}',
      '            for value in values.values(): self._chunk_validate(value)',
      '            return dict(ok=True, version=22, format=22, backend=\'python-sqlite3\', saveCommit=commit, totalKeys=len(values), updatedAt=commit[\'updatedAt\'], values=values,',
      '                        inlineData={k: m[\'inline\'] for k, m in values.items() if \'inline\' in m}, largeKeys=[k for k, m in values.items() if \'inline\' not in m])',
      '',
      '    def stream_chunk_value(self, key, save_id, header, write):',
      '        with self.lock:',
      '            save = self._chunk_save(save_id); save_id = save[\'id\']',
      '            if key not in save[\'hashes\']: raise ValueError(\'Key not found\')',
      '            manifest = self._chunk_manifest(save[\'hashes\'][key]); self._chunk_validate(manifest, True)',
      '            self._chunk_pins[save_id] = self._chunk_pins.get(save_id, 0) + 1',
      '        try:',
      '            header(manifest[\'bytes\'], manifest[\'encoding\'])',
      '            if \'inline\' in manifest: write(manifest[\'inline\'].encode())',
      '            else:',
      '                for chunk in manifest[\'chunks\']:',
      '                    with self.lock: data = self._chunk_bytes(chunk[\'hash\'])',
      '                    write(data)',
      '        finally:',
      '            with self.lock:',
      '                self._chunk_pins[save_id] -= 1',
      '                if not self._chunk_pins[save_id]: del self._chunk_pins[save_id]',
      '',
      '    def read_chunk_value(self, key, save_id=None):',
      '        import io',
      '        output, codec = io.BytesIO(), [\'utf8\']',
      '        self.stream_chunk_value(key, save_id, lambda length, encoding: codec.__setitem__(0, encoding), output.write)',
      '        return output.getvalue().decode(\'utf-16-le\' if codec[0] == \'utf16le\' else \'utf-8\', errors=\'surrogatepass\')',
      '',
      '    def export_chunk_all(self, save_id=None):',
      '        meta = self.export_chunk_meta(save_id)',
      '        meta[\'data\'] = {key: self.read_chunk_value(key, meta[\'saveCommit\'][\'id\']) for key in meta[\'values\']}',
      '        return meta',
      '',
      '    def collect_chunks(self):',
      '        with self.lock:',
      '            self._chunk_schema()',
      '            with self.conn:',
      '                self.conn.execute(\'DELETE FROM chunk_uploads WHERE created_at < ?\', (int(time.time()*1000)-86400000,))',
      '                roots, chunks = set(), set()',
      '                ids = list(self.conn.execute(\'SELECT id FROM chunk_saves ORDER BY created_at DESC\'))',
      '                for i, (save_id,) in enumerate(ids):',
      '                    created = self.conn.execute(\'SELECT created_at FROM chunk_saves WHERE id=?\', (save_id,)).fetchone()[0]',
      '                    if i < 2 or save_id == self._chunk_current_id() or save_id in self._chunk_pins or created > int(time.time()*1000)-120000: roots.update(self._chunk_save(save_id)[\'hashes\'].values())',
      '                    else: self.conn.execute(\'DELETE FROM chunk_saves WHERE id=?\', (save_id,))',
      '                for raw, in self.conn.execute(\'SELECT payload FROM chunk_uploads\'): roots.update(json.loads(raw)[\'entries\'].values())',
      '                for root in roots: chunks.update(c[\'hash\'] for c in self._chunk_manifest(root)[\'chunks\'])',
      '                remove = [sha for sha, in self.conn.execute(\'SELECT hash FROM chunk_blobs\') if sha not in chunks]',
      '                self.conn.executemany(\'DELETE FROM chunk_blobs WHERE hash=?\', [(sha,) for sha in remove])',
      '                self._checked_chunks.difference_update(remove)',
      '                old_values = [root for root, in self.conn.execute(\'SELECT root FROM chunk_values\') if root not in roots]',
      '                self.conn.executemany(\'DELETE FROM chunk_values WHERE root=?\', [(root,) for root in old_values])',
      '                self._checked_values.difference_update(old_values)',
      '            return dict(ok=True, removedChunks=len(remove))',
      '',
      '# END CHUNK STORE',
      'class SqliteDeltaStore(ChunkStoreMixin):',
      '    def __init__(self, db_path):',
      '        self.db_path = db_path',
      '        self.lock = threading.Lock()',
      '        os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)',
      '        self.conn = self._open_conn()',
      '        with self.lock:',
      '            with self.conn:',
      '                self.conn.execute("CREATE TABLE IF NOT EXISTS storage_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL, updated_at INTEGER NOT NULL);")',
      '                self.conn.execute("CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, storage_mode TEXT NOT NULL, value_text TEXT, byte_length INTEGER NOT NULL DEFAULT 0, node_count INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);")',
      '                self.conn.execute("CREATE TABLE IF NOT EXISTS json_nodes (root_key TEXT NOT NULL, node_path TEXT NOT NULL, node_hash TEXT NOT NULL, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (root_key, node_path)) WITHOUT ROWID;")',
      '            self._chunk_schema()',
      '            # Preserve legacy rows until a verified commit.',
      '',
      '    def _migrate_legacy_trees(self, conn):',
      '        try:',
      '            cur = conn.cursor()',
      '            cur.execute("SELECT COUNT(*) FROM kv_store WHERE storage_mode != \'inline\';")',
      '            non_inline = cur.fetchone()[0]',
      '            cur.execute("SELECT COUNT(*) FROM json_nodes;")',
      '            node_cnt = cur.fetchone()[0]',
      '            if non_inline <= 0 and node_cnt <= 0: return',
      '            if non_inline > 0 and node_cnt > 0:',
      '                cur.execute("SELECT root_key, node_path, value_json FROM json_nodes;")',
      '                nodes_by_key = {}',
      '                for rk, np, vj in cur.fetchall():',
      '                    nodes_by_key.setdefault(rk, {})[np] = vj',
      '                cur.execute("SELECT key FROM kv_store WHERE storage_mode != \'inline\';")',
      '                tree_keys = [r[0] for r in cur.fetchall()]',
      '                with conn:',
      '                    for tk in tree_keys:',
      '                        nm = nodes_by_key.get(tk)',
      '                        if nm:',
      '                            full_json = self._reconstruct(nm)',
      '                            conn.execute("UPDATE kv_store SET storage_mode = \'inline\', value_text = ?, byte_length = ?, node_count = 1 WHERE key = ?;", (full_json, len(full_json), tk))',
      '                    conn.execute("DELETE FROM json_nodes;")',
      '            elif node_cnt > 0:',
      '                with conn:',
      '                    conn.execute("DELETE FROM json_nodes;")',
      '            try: conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")',
      '            except Exception: pass',
      '        except Exception:',
      '            pass',
      '',
      '    def _open_conn(self):',
      '        conn = sqlite3.connect(self.db_path, timeout=5.0, check_same_thread=False)',
      '        conn.execute("PRAGMA journal_mode = WAL;")',
      '        conn.execute("PRAGMA synchronous = FULL;")',
      '        conn.execute("PRAGMA temp_store = MEMORY;")',
      '        conn.execute("PRAGMA cache_size = -32000;")',
      '        return conn',
      '',
      '    def shutdown(self):',
      '        with self.lock:',
      '            if self.conn is not None:',
      '                try:',
      '                    self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")',
      '                    self.conn.execute("PRAGMA journal_mode = DELETE;")',
      '                except Exception: pass',
      '                try: self.conn.close()',
      '                except Exception: pass',
      '                self.conn = None',
      '',
      '    def put_raw_bytes(self, key, raw_bytes, char_len=0, revision=1, updated_at=0, checkpoint=False):',
      '        with self.lock:',
      '            if self.has_chunk_save(): raise ValueError("Chunk save requires v22 protocol")',
      '            t0 = time.perf_counter()',
      '            now = int(updated_at) if updated_at and int(updated_at) > 0 else int(time.time() * 1000)',
      '            rev = int(revision) if revision and int(revision) > 0 else 1',
      '            val_text = raw_bytes.decode("utf-8")',
      '            eff_len = int(char_len) if char_len and int(char_len) > 0 else len(val_text)',
      '            if self.conn is None: self.conn = self._open_conn()',
      '            with self.conn:',
      '                self.conn.execute("INSERT OR REPLACE INTO kv_store (key, storage_mode, value_text, byte_length, node_count, revision, updated_at) VALUES (?, \'inline\', ?, ?, 1, ?, ?);", (key, val_text, eff_len, rev, now))',
      '            if checkpoint:',
      '                try: self.conn.execute("PRAGMA wal_checkpoint(PASSIVE);")',
      '                except Exception: pass',
      '            return {"ok": True, "rawSaved": True, "version": 22, "backend": "python-sqlite3", "elapsedMs": round((time.perf_counter() - t0) * 1000, 2), "byteLength": len(raw_bytes)}',
      '',
      '    def get_raw_bytes(self, key):',
      '        with self.lock:',
      '            if self.conn is None: self.conn = self._open_conn()',
      '            cur = self.conn.cursor()',
      '            cur.execute("SELECT storage_mode, value_text FROM kv_store WHERE key = ?;", (key,))',
      '            row = cur.fetchone()',
      '            if row is None: return None',
      '            mode, vt = row',
      '            if mode == "inline": return (vt or "").encode("utf-8")',
      '            cur.execute("SELECT node_path, value_json FROM json_nodes WHERE root_key = ?;", (key,))',
      '            nm = {np: vj for np, vj in cur.fetchall()}',
      '            return self._reconstruct(nm).encode("utf-8")',
      '',
      '    def export_meta(self):',
      '        if self.has_chunk_save(): return self.export_chunk_meta()',
      '        with self.lock:',
      '            t0 = time.perf_counter()',
      '            if self.conn is None: self.conn = self._open_conn()',
      '            cur = self.conn.cursor()',
      '            cur.execute("SELECT key, storage_mode, CASE WHEN storage_mode = \'inline\' AND byte_length <= 65536 AND LENGTH(value_text) <= 65536 THEN value_text ELSE NULL END, byte_length, updated_at FROM kv_store;")',
      '            rows = cur.fetchall()',
      '            inline_data = {}',
      '            large_keys = []',
      '            max_upd = 0',
      '            for k, mode, small_vt, blen, upd in rows:',
      '                if upd and upd > max_upd: max_upd = upd',
      '                if mode == "inline" and small_vt is not None and (blen or 0) <= 65536: inline_data[k] = small_vt',
      '                else: large_keys.append(k)',
      '            return {"ok": True, "version": 22, "backend": "python-sqlite3", "updatedAt": max_upd, "saveCommit": self.get_save_commit(), "totalKeys": len(rows), "inlineData": inline_data, "largeKeys": large_keys, "elapsedMs": round((time.perf_counter() - t0) * 1000, 2)}',
      '',
      '    def _hash_values(self):',
      '        hashes = {}',
      '        for key, value, mode in self.conn.execute("SELECT key, value_text, storage_mode FROM kv_store ORDER BY key"):',
      '            if mode != "inline": raise ValueError("Unverified legacy storage mode")',
      '            hashes[key] = hashlib.sha256((value or "").encode("utf-8")).hexdigest()',
      '        return hashes',
      '',
      '    def _read_commit(self):',
      '        row = self.conn.execute("SELECT meta_value FROM storage_meta WHERE meta_key = \'save_commit\'").fetchone()',
      '        return json.loads(row[0]) if row else None',
      '',
      '    def get_save_commit(self):',
      '        if self.has_chunk_save(): return self._chunk_save()',
      '        commit = self._read_commit()',
      '        if commit is not None:',
      '            try: commit["verified"] = self._hash_values() == commit["hashes"]',
      '            except Exception: commit["verified"] = False',
      '        return commit',
      '',
      '    def commit_save(self, batch):',
      '        with self.lock:',
      '            if not isinstance(batch.get("expectedHashes"), dict) or not batch.get("id"):',
      '                raise ValueError("Save manifest and id are required")',
      '            self.conn.execute("BEGIN IMMEDIATE TRANSACTION")',
      '            try:',
      '                previous = self._read_commit()',
      '                if self._chunk_current_id() != (batch.get("baseId") or ""):',
      '                    raise ValueError("Save conflict: reload the committed save before retrying")',
      '                if batch.get("clearAll"):',
      '                    self.conn.execute("DELETE FROM kv_store")',
      '                    self.conn.execute("DELETE FROM json_nodes")',
      '                for key in batch.get("kvDeletes", []):',
      '                    self.conn.execute("DELETE FROM kv_store WHERE key = ?", (key,))',
      '                    self.conn.execute("DELETE FROM json_nodes WHERE root_key = ?", (key,))',
      '                for item in batch.get("kvUpserts", []):',
      '                    value = item["valueText"]',
      '                    self.conn.execute("INSERT OR REPLACE INTO kv_store (key, storage_mode, value_text, byte_length, node_count, revision, updated_at) VALUES (?, \'inline\', ?, ?, 1, ?, ?)", (item["key"], value, len(value.encode(\'utf-16-le\')) // 2, batch["revision"], batch["updatedAt"]))',
      '                hashes = self._hash_values()',
      '                if hashes != batch["expectedHashes"]:',
      '                    raise ValueError("Save verification failed: key list or SHA-256 mismatch")',
      '                commit = {"id": batch["id"], "revision": batch["revision"], "updatedAt": batch["updatedAt"], "legacyUpdatedAt": batch.get("legacyUpdatedAt", 0), "hashes": hashes, "keyCount": len(hashes), "verified": True}',
      '                self.conn.execute("INSERT OR REPLACE INTO storage_meta (meta_key, meta_value, updated_at) VALUES (\'save_commit\', ?, ?)", (json.dumps(commit, ensure_ascii=False), batch["updatedAt"]))',
      '                self.conn.execute("DELETE FROM storage_meta WHERE meta_key=\'chunk_active\'")',
      '                self.conn.commit()',
      '            except Exception:',
      '                self.conn.rollback()',
      '                raise',
      '            if batch.get("checkpoint"):',
      '                try: self.conn.execute("PRAGMA wal_checkpoint(PASSIVE)")',
      '                except Exception: pass',
      '            return {"ok": True, "version": 22, "backend": "python-sqlite3", "commit": commit}',
      '',
      '    def apply_delta(self, batch):',
      '        with self.lock:',
      '            if self.has_chunk_save(): raise ValueError("Chunk save requires v22 protocol")',
      '            t0 = time.perf_counter()',
      '            now = int(time.time() * 1000)',
      '            if self.conn is None: self.conn = self._open_conn()',
      '            clear_all = bool(batch.get("clearAll"))',
      '            kv_deletes = batch.get("kvDeletes") or []',
      '            kv_upserts = batch.get("kvUpserts") or []',
      '            any_deleted = bool(clear_all or kv_deletes)',
      '            checkpoint_req = bool(batch.get("checkpoint"))',
      '            with self.conn:',
      '                if clear_all:',
      '                    self.conn.execute("DELETE FROM kv_store;")',
      '                    self.conn.execute("DELETE FROM json_nodes;")',
      '                for k in kv_deletes:',
      '                    self.conn.execute("DELETE FROM kv_store WHERE key = ?;", (k,))',
      '                    self.conn.execute("DELETE FROM json_nodes WHERE root_key = ?;", (k,))',
      '                for u in kv_upserts:',
      '                    self.conn.execute("INSERT OR REPLACE INTO kv_store (key, storage_mode, value_text, byte_length, node_count, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?);", (u["key"], u.get("storageMode", "inline"), u.get("valueText"), int(u.get("byteLength", 0)), int(u.get("nodeCount", 1)), int(u.get("revision", 1)), int(u.get("updatedAt", now))))',
      '            if any_deleted or checkpoint_req:',
      '                try: self.conn.execute("PRAGMA wal_checkpoint(PASSIVE);")',
      '                except Exception: pass',
      '            cur = self.conn.cursor()',
      '            cur.execute("SELECT COUNT(*) FROM kv_store;")',
      '            total_kv = cur.fetchone()[0]',
      '            return {"ok": True, "version": 22, "backend": "python-sqlite3", "elapsedMs": round((time.perf_counter() - t0) * 1000, 2), "kvUpserts": len(kv_upserts), "nodeUpserts": 0, "nodeDeletes": 0, "totalKvRows": total_kv, "totalNodeRows": 0}',
      '',
      '    def _reconstruct(self, nodes_map):',
      '        def build(path):',
      '            raw = nodes_map.get(path)',
      '            if raw is None: return "null"',
      '            if not raw.startswith("{") or SENTINEL not in raw: return raw',
      '            parsed = json.loads(raw)',
      '            kind = parsed.get(SENTINEL)',
      '            if kind == "branch":',
      '                order = parsed.get("order") or []',
      '                inline = parsed.get("inline") or {}',
      '                parts = []',
      '                for k in order:',
      '                    kj = json.dumps(k, ensure_ascii=False)',
      '                    if k in inline: parts.append(f"{kj}:{inline[k]}")',
      '                    else: parts.append(f"{kj}:{build(path + \'.\' + escape_path_seg(k))}")',
      '                return "{" + ",".join(parts) + "}"',
      '            if kind == "cdc_array":',
      '                chunks = parsed.get("chunks") or []',
      '                slices = []',
      '                for cid in chunks:',
      '                    cr = nodes_map.get(f"{path}.@{cid}")',
      '                    if cr and len(cr) > 2: slices.append(cr[1:-1])',
      '                return "[" + ",".join(slices) + "]"',
      '            if kind == "cdc_string":',
      '                chunks = parsed.get("chunks") or []',
      '                return "".join(nodes_map.get(f"{path}.@{cid}", "") for cid in chunks)',
      '            return raw',
      '        return build("$")',
      '',
      '    def export_all(self):',
      '        if self.has_chunk_save(): return self.export_chunk_all()',
      '        with self.lock:',
      '            t0 = time.perf_counter()',
      '            if self.conn is None: self.conn = self._open_conn()',
      '            cur = self.conn.cursor()',
      '            cur.execute("SELECT key, storage_mode, value_text, updated_at FROM kv_store;")',
      '            kv_rows = cur.fetchall()',
      '            cur.execute("SELECT root_key, node_path, node_hash, value_json FROM json_nodes;")',
      '            node_rows = cur.fetchall()',
      '            nodes_by_key = {}',
      '            hashes_by_key = {}',
      '            for rk, np, nh, vj in node_rows:',
      '                nodes_by_key.setdefault(rk, {})[np] = vj',
      '                hashes_by_key.setdefault(rk, {})[np] = nh',
      '            data = {}',
      '            max_upd = 0',
      '            for k, mode, vt, upd in kv_rows:',
      '                if upd and upd > max_upd: max_upd = upd',
      '                if mode == "inline": data[k] = vt if vt is not None else ""',
      '                else: data[k] = self._reconstruct(nodes_by_key.get(k) or {})',
      '            return {"ok": True, "version": 22, "backend": "python-sqlite3", "updatedAt": max_upd, "saveCommit": self.get_save_commit(), "totalKeys": len(data), "totalNodes": len(node_rows), "data": data, "nodeHashes": hashes_by_key, "elapsedMs": round((time.perf_counter() - t0) * 1000, 2)}',
      '',
      'def main():',
      '    app_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))',
      '    parent_pid = 0',
      '    for i, a in enumerate(sys.argv):',
      '        if a == "--app-root" and i + 1 < len(sys.argv): app_root = sys.argv[i + 1]',
      '        elif a == "--parent-pid" and i + 1 < len(sys.argv):',
      '            try: parent_pid = int(sys.argv[i + 1])',
      '            except Exception: pass',
      '    userdata_dir = os.path.join(app_root, "userdata")',
      '    os.makedirs(userdata_dir, exist_ok=True)',
      '    ep_path = os.path.join(userdata_dir, "sqlite-endpoint.json")',
      '    try:',
      '        if os.path.exists(ep_path):',
      '            with open(ep_path, "r", encoding="utf-8") as f:',
      '                old_ep = json.load(f)',
      '            if old_ep and old_ep.get("url"):',
      '                req = urllib.request.Request(old_ep["url"] + "/shutdown", method="POST", data=b"")',
      '                urllib.request.urlopen(req, timeout=0.4)',
      '    except Exception: pass',
      '    store = SqliteDeltaStore(os.path.join(userdata_dir, "storage.sqlite"))',
      '',
      '    def graceful_exit():',
      '        try: store.shutdown()',
      '        except Exception: pass',
      '        try:',
      '            if os.path.exists(ep_path): os.remove(ep_path)',
      '        except Exception: pass',
      '        os._exit(0)',
      '',
      '    if parent_pid > 0:',
      '        def watch_parent():',
      '            while True:',
      '                time.sleep(1.5)',
      '                try:',
      '                    os.kill(parent_pid, 0)',
      '                except OSError:',
      '                    graceful_exit()',
      '        threading.Thread(target=watch_parent, daemon=True).start()',
      '',
      '    class Handler(BaseHTTPRequestHandler):',
      '        def log_message(self, format, *args): pass',
      '        def _send_bytes(self, status_code, content_type, body_bytes):',
      '            self.send_response(status_code)',
      '            self.send_header("Content-Type", content_type)',
      '            self.send_header("Access-Control-Allow-Origin", "*")',
      '            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")',
      '            self.send_header("Access-Control-Allow-Headers", "Content-Type, Cache-Control, Pragma, Accept, Authorization, X-Requested-With")',
      '            self.send_header("Cache-Control", "no-store")',
      '            self.send_header("Content-Length", str(len(body_bytes)))',
      '            self.end_headers()',
      '            if body_bytes: self.wfile.write(body_bytes)',
      '        def _send(self, obj):',
      '            body = json.dumps(obj, ensure_ascii=False).encode("utf-8", errors="backslashreplace")',
      '            self._send_bytes(200, "application/json; charset=utf-8", body)',
      '        def do_OPTIONS(self): self._send({})',
      '        def do_GET(self):',
      '            try: self._do_get()',
      '            except Exception as exc: self._send({"ok": False, "error": str(exc)})',
      '        def _do_get(self):',
      '            if self.path.startswith("/ping"): self._send({"ok": True, "version": 22, "backend": "python-sqlite3"})',
      '            elif self.path.startswith("/shutdown"):',
      '                store.shutdown()',
      '                try:',
      '                    if os.path.exists(ep_path): os.remove(ep_path)',
      '                except Exception: pass',
      '                self._send({"ok": True, "shuttingDown": True})',
      '                threading.Timer(0.05, graceful_exit).start()',
      '            elif self.path.startswith("/get-text"):',
      '                qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)',
      '                value = store.read_chunk_value(qs[\'key\'][0], qs.get(\'saveId\', [None])[0])',
      '                self._send_bytes(200, \'application/json\', json.dumps(value, ensure_ascii=True).encode())',
      '            elif self.path.startswith("/get-raw"):',
      '                parsed_url = urllib.parse.urlparse(self.path)',
      '                qs = urllib.parse.parse_qs(parsed_url.query, keep_blank_values=True)',
      '                key = qs.get("key", [""])[0]',
      '                if store.has_chunk_save():',
      '                    def header(length, encoding):',
      '                        self.send_response(200); self.send_header(\'Content-Type\', \'application/octet-stream\'); self.send_header(\'Content-Length\', str(length)); self.send_header(\'Access-Control-Allow-Origin\', \'*\'); self.send_header(\'Cache-Control\', \'no-store\'); self.end_headers()',
      '                    store.stream_chunk_value(key, qs.get(\'saveId\', [None])[0], header, self.wfile.write)',
      '                    return',
      '                raw_val = store.get_raw_bytes(key)',
      '                if raw_val is None: self._send_bytes(404, "text/plain; charset=utf-8", b"")',
      '                else: self._send_bytes(200, "text/plain; charset=utf-8", raw_val)',
      '            elif self.path.startswith("/export-meta"): self._send(store.export_meta())',
      '            elif self.path.startswith("/export-all"): self._send(store.export_all())',
      '            else: self._send({"ok": True, "version": 22})',
      '        def do_POST(self):',
      '            try: self._do_post()',
      '            except Exception as exc: self._send({"ok": False, "error": str(exc)})',
      '        def _do_post(self):',
      '            length = int(self.headers.get("Content-Length", "0"))',
      '            if self.path.startswith("/chunks") and length > 1048576: raise ValueError("Chunk batch exceeds 1 MiB")',
      '            raw_bytes = self.rfile.read(length) if length > 0 else b""',
      '            if len(raw_bytes) < length: return',
      '            if self.path.startswith("/put-raw"):',
      '                parsed_url = urllib.parse.urlparse(self.path)',
      '                qs = urllib.parse.parse_qs(parsed_url.query, keep_blank_values=True)',
      '                key = qs.get("key", [""])[0]',
      '                char_len = int(qs.get("charLen", ["0"])[0] or 0)',
      '                rev = int(qs.get("revision", ["1"])[0] or 1)',
      '                upd = int(qs.get("updatedAt", ["0"])[0] or 0)',
      '                cp = qs.get("checkpoint", ["0"])[0] == "1"',
      '                self._send(store.put_raw_bytes(key, raw_bytes, char_len, rev, upd, cp))',
      '                return',
      '            if self.path.startswith("/chunks"):',
      '                self._send(store.put_chunk_batch(urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)["id"][0], raw_bytes)); return',
      '            raw = raw_bytes.decode("utf-8") if length > 0 else "{}"',
      '            req = json.loads(raw)',
      '            action = req.get("action", "ping")',
      '            payload = req.get("payload") or req',
      '            def resolve_p(rp):',
      '                p = str(rp or "").strip()',
      '                if not p or p in (".", "./", ".\\\\"): return app_root',
      '                if os.path.isabs(p): return os.path.abspath(p)',
      '                return os.path.abspath(os.path.join(app_root, p))',
      '            if action == "prepareChunkSave": self._send(store.prepare_chunk_save(payload))',
      '            elif action == "commitChunkSave": self._send(store.commit_chunk_save(payload["id"]))',
      '            elif action == "chunkMeta": self._send(store.export_chunk_meta(payload.get("id")))',
      '            elif action == "collectChunks": self._send(store.collect_chunks())',
      '            elif action == "commitSave": self._send(store.commit_save(payload))',
      '            elif action == "applyDelta": self._send(store.apply_delta(payload))',
      '            elif action == "exportMeta": self._send(store.export_meta())',
      '            elif action == "exportAll": self._send(store.export_all())',
      '            elif action == "fsReadFile":',
      '                tp = resolve_p(payload.get("path"))',
      '                if not os.path.isfile(tp): self._send({"ok": False, "error": "File not found"})',
      '                else:',
      '                    with open(tp, "r", encoding="utf-8") as f: self._send({"ok": True, "data": f.read()})',
      '            elif action == "fsWriteFile":',
      '                tp = resolve_p(payload.get("path"))',
      '                os.makedirs(os.path.dirname(tp), exist_ok=True)',
      '                with open(tp, "w", encoding="utf-8") as f: f.write(str(payload.get("data") or ""))',
      '                self._send({"ok": True})',
      '            elif action == "fsAppendFile":',
      '                tp = resolve_p(payload.get("path"))',
      '                os.makedirs(os.path.dirname(tp), exist_ok=True)',
      '                with open(tp, "a", encoding="utf-8") as f: f.write(str(payload.get("data") or ""))',
      '                self._send({"ok": True})',
      '            elif action == "fsGetStats":',
      '                tp = resolve_p(payload.get("path"))',
      '                if os.path.isfile(tp): self._send({"ok": True, "isFile": True, "isDirectory": False, "size": os.path.getsize(tp)})',
      '                elif os.path.isdir(tp): self._send({"ok": True, "isFile": False, "isDirectory": True, "size": 0})',
      '                else: self._send({"ok": False, "error": "Not found"})',
      '            elif action == "fsCreateDirectory":',
      '                tp = resolve_p(payload.get("path"))',
      '                os.makedirs(tp, exist_ok=True)',
      '                self._send({"ok": True})',
      '            elif action == "fsRemove":',
      '                import shutil',
      '                tp = resolve_p(payload.get("path"))',
      '                if os.path.isfile(tp): os.remove(tp)',
      '                elif os.path.isdir(tp): shutil.rmtree(tp, ignore_errors=True)',
      '                self._send({"ok": True})',
      '            elif action == "osExecCommand":',
      '                import subprocess',
      '                cmd_s = str(payload.get("command") or "")',
      '                if payload.get("background"):',
      '                    subprocess.Popen(cmd_s, shell=True, cwd=app_root)',
      '                    self._send({"ok": True, "exitCode": 0, "stdOut": "", "stdErr": ""})',
      '                else:',
      '                    cp = subprocess.run(cmd_s, shell=True, cwd=app_root, capture_output=True, text=True, timeout=12)',
      '                    self._send({"ok": True, "exitCode": cp.returncode, "stdOut": cp.stdout, "stdErr": cp.stderr})',
      '            elif action == "shutdown":',
      '                store.shutdown()',
      '                try:',
      '                    if os.path.exists(ep_path): os.remove(ep_path)',
      '                except Exception: pass',
      '                self._send({"ok": True, "shuttingDown": True})',
      '                threading.Timer(0.05, graceful_exit).start()',
      '            else: self._send({"ok": True, "version": 22, "backend": "python-sqlite3"})',
      '',
      '    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)',
      '    port = httpd.server_port',
      '    with open(ep_path, "w", encoding="utf-8") as f:',
      '        json.dump({"port": port, "url": f"http://127.0.0.1:{port}", "pid": os.getpid(), "version": 22, "backend": "python-sqlite3", "updatedAt": int(time.time()*1000)}, f)',
      '    httpd.serve_forever()',
      '',
      'if __name__ == "__main__":',
      '    main()',
    ].join("\n");

    const cmdLauncher = [
      '@echo off',
      'setlocal',
      'cd /d "%~dp0"',
      'set "CSC_PATH=%SystemRoot%\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe"',
      'if not exist "%CSC_PATH%" set "CSC_PATH=%SystemRoot%\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe"',
      'if "%~1"=="--compile-only" goto compile',
      'if exist "neu-sqlite-ext.exe" goto launch',
      ':compile',
      'if not exist "%CSC_PATH%" goto python',
      '"%CSC_PATH%" /nologo /target:winexe /optimize+ /r:System.dll /r:System.Web.Extensions.dll /out:neu-sqlite-ext.exe NeuSqliteExtension.cs >compile.log 2>&1',
      'if errorlevel 1 (',
      '  type compile.log >&2',
      '  exit /b 1',
      ')',
      'if "%~1"=="--compile-only" exit /b 0',
      ':launch',
      'start "" neu-sqlite-ext.exe %*',
      'exit /b 0',
      ':python',
      'if "%~1"=="--compile-only" (',
      '  echo C# compiler unavailable; Python fallback will be used. >&2',
      '  exit /b 1',
      ')',
      'python -c "import sqlite3" >nul 2>&1 && (',
      '  start "" /b python main.py %*',
      '  exit /b 0',
      ')',
      'python3 -c "import sqlite3" >nul 2>&1 && (',
      '  start "" /b python3 main.py %*',
      '  exit /b 0',
      ')',
      'echo No working SQLite backend found. >&2',
      'exit /b 1',
    ].join("\r\n");

    const shLauncher = [
      '#!/usr/bin/env sh',
      'EXT_DIR="$(cd "$(dirname "$0")" && pwd)"',
      'APP_ROOT="$(cd "$EXT_DIR/../.." && pwd)"',
      'exec python3 "$EXT_DIR/main.py" --app-root "$APP_ROOT" "$@"',
    ].join("\n");

    return {
      csharpSource,
      pythonSource,
      cmdLauncher,
      shLauncher,
    };
  }

  function parseNeutralinoGlobalsFromSource(code, targetGlobal = global) {
    if (!code || typeof code !== 'string') return false;
    let foundAny = false;
    const regex = /\b(?:let|const|var)\s+(NL_[A-Za-z0-9_]+)\s*=\s*([^;\r\n]+);/g;
    let match;
    while ((match = regex.exec(code)) !== null) {
      const key = match[1];
      const rawVal = match[2].trim();
      let val;
      try {
        val = JSON.parse(rawVal);
      } catch (_) {
        if (
          (rawVal.startsWith("'") && rawVal.endsWith("'")) ||
          (rawVal.startsWith('"') && rawVal.endsWith('"'))
        ) {
          val = rawVal
            .slice(1, -1)
            .replace(/\\\\/g, '\\')
            .replace(/\\'/g, "'")
            .replace(/\\"/g, '"');
        } else if (/^\d+$/.test(rawVal)) {
          val = Number(rawVal);
        } else if (rawVal === 'true') {
          val = true;
        } else if (rawVal === 'false') {
          val = false;
        }
      }

      if (val !== undefined) {
        if ((key === 'NL_TOKEN' || key === 'NL_CONNECT_TOKEN') && !val && targetGlobal[key]) {
          continue;
        }
        targetGlobal[key] = val;
        foundAny = true;
      }
    }
    return foundAny;
  }

  function isLocalNeutralinoUrl() {
    if (typeof window === 'undefined' || !window.location) return false;
    const { protocol, hostname, port } = window.location;
    if (protocol === 'http:' && (hostname === '127.0.0.1' || hostname === 'localhost') && port) {
      return true;
    }
    return false;
  }

  function disableDesktopServiceWorkers() {
    // Desktop assets are served locally; PWA workers can be absent or cache old game files.
    if (!isLocalNeutralinoUrl() || !global.NL_APPID || !global.navigator) return false;
    const owners = [];
    for (let owner = global.navigator; owner; owner = Object.getPrototypeOf(owner)) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, 'serviceWorker');
      if (!descriptor) continue;
      if (!descriptor.configurable) return false;
      owners.push(owner);
    }
    // Hide the unsupported feature so existing "serviceWorker" in navigator guards skip it.
    // Dedicated Workers used for saving remain available.
    for (const owner of owners) Reflect.deleteProperty(owner, 'serviceWorker');
    return !('serviceWorker' in global.navigator);
  }

  function inferOsFromNavigator() {
    if (typeof navigator === 'undefined') return 'Windows';
    const ua = `${navigator.userAgent || ''} ${navigator.platform || ''}`.toLowerCase();
    if (ua.includes('win')) return 'Windows';
    if (ua.includes('mac') || ua.includes('darwin')) return 'Darwin';
    if (ua.includes('linux')) return 'Linux';
    return 'Windows';
  }

  function syncLexicalGlobalsToWindow() {
    try {
      if (global.__early_NL_TOKEN && !global.NL_TOKEN) {
        global.NL_TOKEN = global.__early_NL_TOKEN;
      }
      if (global.__early_NL_CONNECT_TOKEN && !global.NL_CONNECT_TOKEN) {
        global.NL_CONNECT_TOKEN = global.__early_NL_CONNECT_TOKEN;
      }
      if (global.__early_NL_PORT && !global.NL_PORT) {
        global.NL_PORT = Number(global.__early_NL_PORT);
      }
    } catch (_) {}
    try {
      if (typeof NL_OS !== 'undefined' && NL_OS) global.NL_OS = NL_OS;
    } catch (_) {}
    try {
      if (typeof NL_APPID !== 'undefined' && NL_APPID) global.NL_APPID = NL_APPID;
    } catch (_) {}
    try {
      if (typeof NL_PORT !== 'undefined' && NL_PORT) global.NL_PORT = Number(NL_PORT);
    } catch (_) {}
    try {
      if (typeof NL_MODE !== 'undefined' && NL_MODE) global.NL_MODE = NL_MODE;
    } catch (_) {}
    try {
      if (typeof NL_VERSION !== 'undefined' && NL_VERSION) global.NL_VERSION = NL_VERSION;
    } catch (_) {}
    try {
      if (typeof NL_CWD !== 'undefined' && NL_CWD) global.NL_CWD = NL_CWD;
    } catch (_) {}
    try {
      if (typeof NL_PATH !== 'undefined' && NL_PATH) global.NL_PATH = NL_PATH;
    } catch (_) {}
    try {
      if (typeof NL_ARGS !== 'undefined' && NL_ARGS) global.NL_ARGS = NL_ARGS;
    } catch (_) {}
    try {
      if (global.__early_NL_PID && !global.NL_PID) {
        global.NL_PID = Number(global.__early_NL_PID);
      }
      if (typeof NL_PID !== 'undefined' && NL_PID) {
        global.NL_PID = Number(NL_PID);
        global.__early_NL_PID = Number(NL_PID);
      }
    } catch (_) {}
    try {
      if (typeof NL_TOKEN !== 'undefined' && NL_TOKEN) global.NL_TOKEN = NL_TOKEN;
    } catch (_) {}
    try {
      if (typeof NL_CONNECT_TOKEN !== 'undefined' && NL_CONNECT_TOKEN) {
        global.NL_CONNECT_TOKEN = NL_CONNECT_TOKEN;
      }
    } catch (_) {}
    try {
      if (typeof Neutralino !== 'undefined' && Neutralino && !global.Neutralino) {
        global.Neutralino = Neutralino;
      }
    } catch (_) {}

    if (nativeSessionStorage) {
      const savedPort = Number(sessionGet('__NEU_BAK_NL_PORT') || 0);
      const currentLocPort = isLocalNeutralinoUrl() ? Number(window.location.port) : 0;
      const isPortMismatch = Boolean(savedPort && currentLocPort && savedPort !== currentLocPort);
      if (isPortMismatch) {
        try {
          nativeSessionStorage.removeItem('__NEU_BAK_NL_TOKEN');
          nativeSessionStorage.removeItem('__NEU_BAK_NL_CONNECT_TOKEN');
          nativeSessionStorage.removeItem('NL_TOKEN');
        } catch (_) {}
      }
      for (const key of SESSION_KEYS) {
        try {
          const currentVal = global[key];
          if (currentVal !== undefined && currentVal !== null && String(currentVal) !== '') {
            sessionSet(`__NEU_BAK_${key}`, String(currentVal));
            if (key === 'NL_TOKEN') {
              sessionSet('NL_TOKEN', String(currentVal));
            }
          } else {
            if (isPortMismatch && (key === 'NL_TOKEN' || key === 'NL_CONNECT_TOKEN' || key === 'NL_PORT')) {
              continue;
            }
            const restored =
              sessionGet(`__NEU_BAK_${key}`) ||
              (key === 'NL_TOKEN' ? sessionGet('NL_TOKEN') : null);
            if (restored !== null && restored !== '') {
              global[key] = key === 'NL_PORT' || key === 'NL_PID' ? Number(restored) : restored;
            }
          }
        } catch (_) {}
      }
    }

    if (global.NL_TOKEN && !global.__early_NL_TOKEN) {
      global.__early_NL_TOKEN = global.NL_TOKEN;
    }
    if (global.NL_CONNECT_TOKEN && !global.__early_NL_CONNECT_TOKEN) {
      global.__early_NL_CONNECT_TOKEN = global.NL_CONNECT_TOKEN;
    }
    try {
      if (typeof NL_TOKEN !== 'undefined' && !NL_TOKEN && global.NL_TOKEN) {
        // eslint-disable-next-line no-undef
        NL_TOKEN = global.NL_TOKEN;
      }
    } catch (_) {}
    try {
      if (typeof NL_PORT !== 'undefined' && !NL_PORT && global.NL_PORT) {
        // eslint-disable-next-line no-undef
        NL_PORT = global.NL_PORT;
      }
    } catch (_) {}
  }

  function getAppRootDir() {
    syncLexicalGlobalsToWindow();
    const cwd = normalizeSlashes(global.NL_CWD || '').replace(/\/+$/, '');
    const nlPath = normalizeSlashes(global.NL_PATH || '.').replace(/\/+$/, '');

    if (nlPath && nlPath !== '.' && nlPath !== './') {
      if (/^[a-zA-Z]:\//.test(nlPath) || nlPath.startsWith('/')) {
        return nlPath;
      }
      if (cwd) {
        return joinPath(cwd, nlPath);
      }
      return nlPath;
    }
    return cwd || '.';
  }

  function ensureNeutralinoEnvironment() {
    if (typeof window === 'undefined') return false;

    syncLexicalGlobalsToWindow();

    if (!global.__NEU_DETECTED_CONFIG__) {
      const cfgCandidates = [
        '/neutralino.config.json',
        './neutralino.config.json',
        '../neutralino.config.json',
      ];
      for (const cfgUrl of cfgCandidates) {
        const rawCfg = syncHttpGetText(cfgUrl, false);
        if (rawCfg) {
          try {
            const parsedCfg = JSON.parse(rawCfg);
            if (parsedCfg && (parsedCfg.applicationId || parsedCfg.defaultMode || parsedCfg.modes)) {
              global.__NEU_DETECTED_CONFIG__ = parsedCfg;
              break;
            }
          } catch (_) {}
        }
      }
    }

    // 1순위: 현재 실행 중인 Neutralino C++ 서버가 메모리에서 직접 주입하는 /__neutralino_globals.js 및 /neutralino.js를 최우선 확인
    // (디스크에 이전 세션의 .tmp/auth_info.json이 남아 구버전 토큰으로 WebSocket 400 오류가 발생하는 현상 원천 차단)
    if (!global.NL_PORT || !global.NL_TOKEN) {
      const scriptCandidates = [
        '/__neutralino_globals.js',
        './__neutralino_globals.js',
        '../__neutralino_globals.js',
      ];

      const detectedCfg = global.__NEU_DETECTED_CONFIG__;
      if (detectedCfg && detectedCfg.cli && detectedCfg.cli.clientLibrary) {
        const cl = String(detectedCfg.cli.clientLibrary);
        scriptCandidates.push(cl.startsWith('/') ? cl : '/' + cl);
        if (detectedCfg.documentRoot) {
          const docRoot = normalizeSlashes(detectedCfg.documentRoot).replace(/\/+$/, '');
          const normCl = normalizeSlashes(cl);
          if (docRoot && normCl.startsWith(docRoot + '/')) {
            scriptCandidates.push(normCl.slice(docRoot.length));
          }
        }
      }

      scriptCandidates.push(
        '/neutralino.js',
        './neutralino.js',
        '../neutralino.js',
        '/resources/neutralino.js',
        './resources/neutralino.js',
        '/js/neutralino.js',
        './js/neutralino.js',
        '/resources/js/neutralino.js',
        './resources/js/neutralino.js'
      );

      const tried = new Set();
      for (const scriptUrl of scriptCandidates) {
        if (!scriptUrl || tried.has(scriptUrl)) continue;
        tried.add(scriptUrl);

        const code = syncHttpGetText(scriptUrl, false);
        if (!code) continue;

        const extracted = parseNeutralinoGlobalsFromSource(code, global);
        if (extracted) {
          syncLexicalGlobalsToWindow();
        }

        if (global.NL_PORT && global.NL_TOKEN) {
          break;
        }
      }
    }

    // 2순위 폴백: 스크립트에서 토큰을 찾지 못한 경우에만 .tmp/auth_info.json 확인
    if (!global.NL_PORT || !global.NL_TOKEN) {
      const authCandidates = [
        '/.tmp/auth_info.json',
        './.tmp/auth_info.json',
        '../.tmp/auth_info.json',
        '/auth_info.json',
      ];
      for (const authUrl of authCandidates) {
        const rawAuth = syncHttpGetText(authUrl, false);
        if (rawAuth) {
          try {
            const parsed = JSON.parse(rawAuth);
            const port = Number(parsed.nlPort || parsed.port || 0);
            const token = parsed.nlToken || parsed.accessToken;
            const locPort = isLocalNeutralinoUrl() ? Number(window.location.port) : 0;
            if (locPort && port && port !== locPort) {
              continue;
            }
            if (port) global.NL_PORT = port;
            if (token && !global.NL_TOKEN) global.NL_TOKEN = String(token);
            syncLexicalGlobalsToWindow();
            if (global.NL_PORT && global.NL_TOKEN) break;
          } catch (_) {}
        }
      }
    }

    if (!global.NL_PORT && isLocalNeutralinoUrl()) {
      global.NL_PORT = Number(window.location.port);
    }

    if (!global.NL_OS && (global.NL_PORT || isLocalNeutralinoUrl())) {
      global.NL_OS = inferOsFromNavigator();
    }

    syncLexicalGlobalsToWindow();

    const shouldInstallResilientRpc =
      global.NL_PORT &&
      (!global.Neutralino ||
        (!global.Neutralino.__IS_MINIMAL_RPC_CLIENT__ &&
          typeof WebSocket === 'function' &&
          isLocalNeutralinoUrl()));

    if (shouldInstallResilientRpc) {
      global.Neutralino = createMinimalNeutralinoRpcClient();
    }

    // Environment detection alone does not open the native connection.
    // setupLifecycleHooks initializes it after subscribing to native close events;
    // native RPC calls can also connect on demand.
    global.__NEUTRALINO_CLIENT_INITIALIZED__ = true;

    return Boolean(global.NL_PORT || global.Neutralino || isLocalNeutralinoUrl());
  }

  function createMinimalNeutralinoRpcClient() {
    let ws = null;
    let isReady = false;
    let wsHandshakeFailures = 0;
    let wsHandshakeRejected = false;
    const pending = new Map();
    const queue = [];
    const eventListeners = new Map();

    function clearCachedTokens() {
      try {
        delete global.NL_TOKEN;
        delete global.NL_CONNECT_TOKEN;
        delete global.__early_NL_TOKEN;
        delete global.__early_NL_CONNECT_TOKEN;
      } catch (_) {}
      try {
        if (nativeSessionStorage) {
          nativeSessionStorage.removeItem('__NEU_BAK_NL_TOKEN');
          nativeSessionStorage.removeItem('__NEU_BAK_NL_CONNECT_TOKEN');
          nativeSessionStorage.removeItem('NL_TOKEN');
        }
      } catch (_) {}
    }

    function refreshTokenFromScriptsIfNeeded() {
      const prevToken = String(global.NL_TOKEN || '');
      clearCachedTokens();

      // 반드시 C++ 서버가 실시간 생성하는 /__neutralino_globals.js를 최우선으로 조회
      const scripts = [
        '/__neutralino_globals.js',
        './__neutralino_globals.js',
        '/neutralino.js',
        './neutralino.js',
      ];
      for (const sUrl of scripts) {
        const code = syncHttpGetText(sUrl, true);
        if (code && parseNeutralinoGlobalsFromSource(code, global)) {
          if (global.NL_TOKEN) {
            const parts = String(global.NL_TOKEN).split('.');
            if (parts[1]) {
              global.NL_CONNECT_TOKEN = parts[1];
              global.__early_NL_CONNECT_TOKEN = parts[1];
            }
            syncLexicalGlobalsToWindow();
            return String(global.NL_TOKEN) !== prevToken;
          }
        }
      }
      const authUrls = ['/.tmp/auth_info.json', './.tmp/auth_info.json', '/auth_info.json'];
      const locPort = isLocalNeutralinoUrl() ? Number(window.location.port) : 0;
      for (const aUrl of authUrls) {
        const raw = syncHttpGetText(aUrl, true);
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            const port = Number(parsed.nlPort || parsed.port || 0);
            const token = parsed.nlToken || parsed.accessToken;
            if ((!locPort || !port || port === locPort) && token) {
              global.NL_TOKEN = String(token);
              const parts = String(token).split('.');
              if (parts[1]) {
                global.NL_CONNECT_TOKEN = parts[1];
                global.__early_NL_CONNECT_TOKEN = parts[1];
              }
              if (port) global.NL_PORT = port;
              syncLexicalGlobalsToWindow();
              return String(global.NL_TOKEN) !== prevToken;
            }
          } catch (_) {}
        }
      }
      if (prevToken) {
        global.NL_TOKEN = prevToken;
        const parts = prevToken.split('.');
        if (parts[1]) global.NL_CONNECT_TOKEN = parts[1];
      }
      return false;
    }

    function getTokens() {
      syncLexicalGlobalsToWindow();
      if (!global.NL_TOKEN) {
        refreshTokenFromScriptsIfNeeded();
      }
      const rawToken = String(global.NL_TOKEN || '');
      const tokenParts = rawToken.split('.');
      // Neutralino C++ authbasic::verifyToken requires the FULL NL_TOKEN ("token.connectToken") as accessToken,
      // and tokenParts[1] is always the authoritative connectToken matching NL_TOKEN.
      const accessToken = rawToken;
      const connectToken = tokenParts[1] || global.NL_CONNECT_TOKEN || '';
      return { accessToken, connectToken };
    }

    function getPort() {
      syncLexicalGlobalsToWindow();
      if (global.NL_PORT) return Number(global.NL_PORT);
      if (isLocalNeutralinoUrl()) return Number(window.location.port);
      return 0;
    }

    function rejectAllPending(errMsg) {
      while (queue.length > 0) {
        queue.shift();
      }
      if (pending.size > 0) {
        for (const [reqId, entry] of Array.from(pending.entries())) {
          pending.delete(reqId);
          if (entry.timer) clearTimeout(entry.timer);
          try {
            entry.reject(new Error(errMsg));
          } catch (_) {}
        }
      }
    }

    function connect() {
      if (wsHandshakeRejected) {
        return;
      }
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
      }
      const port = getPort();
      if (typeof WebSocket === 'undefined' || !port) return;

      const { connectToken } = getTokens();
      const host = (window.location && window.location.hostname) || '127.0.0.1';
      const query = connectToken ? `?connectToken=${encodeURIComponent(connectToken)}` : '';
      let currentWs = null;
      let openedOnce = false;
      try {
        currentWs = new WebSocket(`ws://${host}:${port}${query}`);
        ws = currentWs;
      } catch (_) {
        wsHandshakeRejected = true;
        return;
      }

      currentWs.addEventListener('open', () => {
        openedOnce = true;
        isReady = true;
        wsHandshakeFailures = 0;
        wsHandshakeRejected = false;
        while (queue.length > 0) {
          currentWs.send(queue.shift());
        }
      });

      currentWs.addEventListener('close', () => {
        if (ws === currentWs) {
          ws = null;
        }
        isReady = false;

        if (!openedOnce) {
          wsHandshakeFailures++;
          // 첫 핸드셰이크가 HTTP 400으로 거부된 경우:
          // 스크립트에서 새 토큰이 발견된 경우에만 단 1회 재시도하고, 동일 토큰이거나 또 실패하면 즉시 서킷 브레이커를 작동시켜
          // 600ms 무한 재연결 루프 및 콘솔 WebSocket 400 오류 반복을 완전히 차단합니다.
          if (wsHandshakeFailures === 1) {
            const tokenChanged = refreshTokenFromScriptsIfNeeded();
            if (tokenChanged && (!global.__storageBridge || !global.__storageBridge.isClosing)) {
              setTimeout(() => {
                try {
                  connect();
                } catch (_) {}
              }, 150);
              return;
            }
          }
          wsHandshakeRejected = true;
          rejectAllPending('Neutralino WebSocket 핸드셰이크가 거부되어 HTTP 데몬 폴백으로 전환합니다.');
          return;
        }

        rejectAllPending('내부 통신 연결이 일시적으로 닫혔습니다.');
      });

      currentWs.addEventListener('error', () => {
        isReady = false;
      });

      currentWs.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending.has(msg.id)) {
            const entry = pending.get(msg.id);
            pending.delete(msg.id);
            if (entry.timer) clearTimeout(entry.timer);
            if (msg.data && msg.data.error) {
              const errObj = msg.data.error;
              if (errObj && errObj.code === 'NE_RT_INVTOKN') {
                refreshTokenFromScriptsIfNeeded();
              }
              const errMsg =
                typeof errObj === 'string'
                  ? errObj
                  : (errObj && errObj.message) || JSON.stringify(errObj);
              const wrappedErr = new Error(errMsg);
              if (errObj && errObj.code) wrappedErr.code = errObj.code;
              entry.reject(wrappedErr);
            } else {
              entry.resolve(msg.data ? msg.data.returnValue ?? msg.data : undefined);
            }
          } else if (msg.event) {
            const customEv = new CustomEvent(msg.event, { detail: msg.data });
            if (eventListeners.has(msg.event)) {
              for (const fn of eventListeners.get(msg.event)) {
                try {
                  fn(customEv);
                } catch (_) {}
              }
            }
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
              try {
                window.dispatchEvent(customEv);
              } catch (_) {}
            }
          }
        } catch (_) {}
      });
    }

    let rpcAuthVerified = false;

    function sendMessageRaw(method, data, timeoutMs = 5000) {
      if (wsHandshakeRejected) {
        return Promise.reject(
          new Error('WebSocket 연결이 비활성화되어 HTTP 데몬 경로를 사용합니다.')
        );
      }
      connect();
      if (wsHandshakeRejected) {
        return Promise.reject(
          new Error('WebSocket 연결이 비활성화되어 HTTP 데몬 경로를 사용합니다.')
        );
      }
      const { accessToken } = getTokens();
      return new Promise((resolve, reject) => {
        const port = getPort();
        if (!port) {
          reject(new Error('프로그램 내부 연결을 확인할 수 없습니다. 프로그램을 다시 실행해 주세요.'));
          return;
        }
        if (!accessToken) {
          reject(
            new Error(
              '실행 권한 토큰(NL_TOKEN)이 비어 있습니다. neutralino.config.json의 clientLibrary 경로가 "/neutralino.js"로 설정되어 있는지 확인해 주세요.'
            )
          );
          return;
        }

        const id =
          'rpc_' +
          Date.now().toString(36) +
          '_' +
          Math.random().toString(36).slice(2, 9);

        let timer = null;
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            if (pending.has(id)) {
              pending.delete(id);
              reject(
                new Error('프로그램 내부 통신 응답 시간이 초과되었습니다.')
              );
            }
          }, timeoutMs);
        }

        pending.set(id, {
          resolve: (val) => {
            rpcAuthVerified = true;
            resolve(val);
          },
          reject: (err) => {
            rpcAuthVerified = true;
            reject(err);
          },
          timer,
        });
        const payload = JSON.stringify({
          id,
          method,
          accessToken,
          data: data || {},
        });
        if (isReady && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
        } else {
          queue.push(payload);
        }
      });
    }

    async function sendMessage(method, data, timeoutMs = 5000) {
      try {
        if (timeoutMs === 0 && !rpcAuthVerified) {
          await sendMessageRaw('filesystem.getStats', { path: '.' }, 1200);
        }
        return await sendMessageRaw(method, data, timeoutMs);
      } catch (err) {
        if (err && (err.code === 'NE_RT_INVTOKN' || String(err.message || err).includes('NL_TOKEN'))) {
          if (refreshTokenFromScriptsIfNeeded()) {
            try {
              if (ws) ws.close();
            } catch (_) {}
            ws = null;
            isReady = false;
            return await sendMessageRaw(method, data, timeoutMs);
          }
        }
        throw err;
      }
    }

    return {
      __IS_MINIMAL_RPC_CLIENT__: true,
      isWsRejected() {
        return wsHandshakeRejected;
      },
      init() {
        // Native events (including windowClose) require a live connection even
        // when all storage operations use the HTTP daemon.
        connect();
      },
      filesystem: {
        readFile(path) {
          return sendMessage('filesystem.readFile', { path }, 30000);
        },
        writeFile(path, data) {
          return sendMessage('filesystem.writeFile', { path, data }, 30000);
        },
        appendFile(path, data) {
          return sendMessage('filesystem.appendFile', { path, data }, 30000);
        },
        getStats(path) {
          return sendMessage('filesystem.getStats', { path }, 4000);
        },
        createDirectory(path) {
          return sendMessage('filesystem.createDirectory', { path }, 4000);
        },
        remove(path) {
          return sendMessage('filesystem.remove', { path }, 4000);
        },
      },
      os: {
        execCommand(command, options = {}) {
          if (wsHandshakeRejected && global.__storageBridge && global.__storageBridge.sqliteEndpointUrl) {
            return global.__storageBridge
              .callSqliteExtension('osExecCommand', { command, ...options }, 15000)
              .then((res) => {
                if (res && res.ok) return res;
                throw new Error((res && res.error) || 'osExecCommand failed');
              });
          }
          return sendMessage('os.execCommand', { command, ...options }, 15000).catch(async (err) => {
            if (global.__storageBridge && global.__storageBridge.sqliteEndpointUrl) {
              const res = await global.__storageBridge.callSqliteExtension(
                'osExecCommand',
                { command, ...options },
                15000
              );
              if (res && res.ok) return res;
            }
            throw err;
          });
        },
        open(url) {
          return sendMessage('os.open', { url }, 5000);
        },
        showOpenDialog(title, options = {}) {
          return sendMessage('os.showOpenDialog', { title, ...options }, 0);
        },
        showSaveDialog(title, options = {}) {
          return sendMessage('os.showSaveDialog', { title, ...options }, 0);
        },
      },
      extensions: {
        dispatch(extensionId, event, data) {
          return sendMessage('extensions.dispatch', { extensionId, event, data }, 10000);
        },
        getStats() {
          return sendMessage('extensions.getStats', {}, 4000);
        },
      },
      app: {
        exit(code = 0) {
          return sendMessage('app.exit', { code }, 2000);
        },
        killProcess() {
          return sendMessage('app.killProcess', {}, 2000);
        },
      },
      events: {
        on(eventName, handler) {
          // 지연 연결: 이벤트 리스너만 등록하고 WebSocket 핸드셰이크를 강제 유발하지 않음
          if (!eventListeners.has(eventName)) {
            eventListeners.set(eventName, []);
          }
          eventListeners.get(eventName).push(handler);
          return Promise.resolve();
        },
      },
    };
  }

  class NeutralinoStorageBridge {
    constructor(userConfig = {}) {
      this.__BRIDGE_VERSION__ = BRIDGE_VERSION;
      this.config = { ...DEFAULT_CONFIG, ...userConfig };
      this.memory =
        previousBridge && previousBridge.memory instanceof Map
          ? previousBridge.memory
          : new Map();

      this.nodeHashesByKey =
        previousBridge && previousBridge.nodeHashesByKey instanceof Map
          ? previousBridge.nodeHashesByKey
          : new Map();

      this.nodeCountByKey =
        previousBridge && previousBridge.nodeCountByKey instanceof Map
          ? previousBridge.nodeCountByKey
          : new Map();

      this.dirtyDexieKeys = new Set();
      this.dirtyDexieDeletes = new Set();
      this.dirtyDexieClear = false;

      this.dirtySqliteKeys = new Set();
      this.dirtySqliteDeletes = new Set();
      this.dirtySqliteClear = false;

      this.pendingNodeUpsertsDexie = new Map();
      this.pendingNodeDeletesDexie = new Set();

      this.pendingNodeUpsertsSqlite = new Map();
      this.pendingNodeDeletesSqlite = new Map();

      this.dexieDb = null;
      this.isExternalDexieLoaded = false;
      this.dexieTimer = null;
      this.dexieFlushPromise = null;

      this.sqliteEndpointUrl = null;
      this.sqliteBackendName = null;
      this.sqliteConnected = false;
      this.sqliteTimer = null;
      this.sqliteIdleHandle = null;
      this.sqliteFlushPromise = null;
      this.sqliteWsPending = new Map();
      this.customSqliteStore = userConfig.customSqliteStore || null;

      this.deltaWorker = createJsonDeltaWorkerClient();

      this.lastDeltaBytes = 0;
      this.lastDeltaNodes = 0;
      this.totalSavedBytes = 0;

      this.revision = previousBridge && typeof previousBridge.revision === "number" ? previousBridge.revision : 0;
      this.keyRevisionMap =
        previousBridge && previousBridge.keyRevisionMap instanceof Map
          ? previousBridge.keyRevisionMap
          : new Map();
      this.lastModifiedAt = previousBridge && previousBridge.lastModifiedAt ? previousBridge.lastModifiedAt : 0;
      this.lastSqliteSyncedAt = null;
      this.lastDirectDiskSyncedAt = null;
      this.lastDexieSyncedAt = null;
      this.externalBlobMap = new Map();
      this._loadedFromSqliteAtBootstrap = false;
      this._loadedFromWindowNameCarrier = false;
      this._windowNameHadOmittedLargeKeys = false;
      this._legacyFilesCleanedUp = false;
      this._verifiedSqliteCommit = null;
      this._sqliteBaseId = '';
      this._legacyImportedAt = 0;
      this._bootstrapComplete = false;
      this._storageLoadError = null;
      this.lastSaveError = null;
      this._gameAutosave = null;
      this._gameAutosaveError = null;
      this._gameAutosaveSuspended = false;

      this.writeLocks = new Map();
      this.initialized = false;
      this.lifecycleHooked = false;
      this.isClosing = false;
      this.storageDir = null;
      this.sqliteDbPath = null;
      this.sqliteEndpointPath = null;
      this.legacyMainFilePath = null;
      this.launcherConfigPath = null;
      this.launcherConfig =
        previousBridge && previousBridge.launcherConfig
          ? { ...previousBridge.launcherConfig }
          : {
              gameHtmlPath: '',
              mountedUrl: '',
              isExternalMount: false,
              autoLaunch: false,
              lastBackupImportedAt: null,
              updatedAt: null,
            };
      this.proxy = null;
    }

    log(...args) {
      if (this.config.debug) {
        console.log('[NeutralinoStorageBridge]', ...args);
      }
    }

    rewriteGameAutosaveBootstrap(html) {
      if (this.config.coalesceGameAutosave === false) return html;
      // These are WML's stable bridge names, not minified game symbols. Unknown
      // bundles keep their original behavior rather than being patched broadly.
      const pattern = /(engine:\s*__wmlE\s*,\s*render:\s*)(__wmlRender)(?=\s*\})/g;
      if (Array.from(html.matchAll(pattern)).length !== 1) return html;
      return html.replace(pattern, '$1(globalThis.__storageBridge && typeof globalThis.__storageBridge.wrapGameRender === "function" ? globalThis.__storageBridge.wrapGameRender(__wmlE, $2) : $2)');
    }

    wrapGameRender(engine, render) {
      const bridge = this;
      return function (...args) {
        // WML calls render only after every mod has installed its storage hooks.
        try { bridge.attachGameAutosave(engine); }
        catch (error) { bridge.log('자동저장 최적화 연결 실패:', error); }
        return render.apply(this, args);
      };
    }

    attachGameAutosave(engine) {
      if (this.config.coalesceGameAutosave === false || !this.isNeutralinoConnected() || !engine) return false;
      for (const binding of Object.keys(engine)) {
        let store, options;
        try {
          store = engine[binding];
          if (!store || !store.persist || typeof store.getState !== 'function' ||
              typeof store.persist.getOptions !== 'function' || typeof store.persist.setOptions !== 'function') continue;
          options = store.persist.getOptions();
        } catch (_) { continue; }
        if (!options || options.name !== 'tavern-game') continue;
        if (this._gameAutosave && this._gameAutosave.store === store) return true;
        const base = options.storage;
        if (!base || typeof base.setItem !== 'function' || typeof base.getItem !== 'function' || typeof base.removeItem !== 'function') return false;
        if (base.setItem.constructor && base.setItem.constructor.name === 'AsyncFunction') return false;
        this.flushPendingGameAutosave();
        const bridge = this, key = options.name;
        let pending = false, timer = null, firstAt = null, sequence = 0, latestValue, flushing = false;
        let requests = 0, serializations = 0, mergedRequests = 0;
        const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
        const clearError = () => {
          if (bridge._gameAutosaveError && bridge.lastSaveError === bridge._gameAutosaveError.message) bridge.lastSaveError = null;
          bridge._gameAutosaveError = null;
        };
        const queue = {
          key, store,
          get pending() { return pending; },
          get flushing() { return flushing; },
          stats: () => ({ key, requests, serializations, mergedRequests, pending }),
          cancel() { clearTimer(); pending = false; latestValue = undefined; firstAt = null; sequence++; clearError(); },
          flush() {
            if (!pending || flushing) return;
            clearTimer();
            const saving = sequence;
            flushing = true;
            try {
              // Take the current state at the actual autosave boundary. Keeping
              // an older object reference would assume that every mod is immutable.
              const current = store.persist.getOptions();
              const state = { ...store.getState() };
              const value = current.name === key ? { ...latestValue,
                state: typeof current.partialize === 'function' ? current.partialize(state) : state,
                version: current.version } : latestValue;
              serializations++;
              const result = base.setItem(key, value);
              if (result && typeof result.then === 'function') {
                Promise.resolve(result).catch(() => {});
                const error = new Error('동기식 자동저장을 예상했지만 비동기 저장 계층이 감지되었습니다. 자동저장 최적화를 끄고 다시 실행해 주세요.');
                bridge._storageLoadError = error;
                throw error;
              }
              if (saving === sequence) { pending = false; latestValue = undefined; firstAt = null; }
              clearError();
              return result;
            } catch (error) {
              bridge._gameAutosaveError = error;
              bridge.lastSaveError = error.message;
              try { bridge.showActionToast('자동저장 준비 실패: ' + error.message, true); } catch (_) {}
              throw error;
            } finally { flushing = false; }
          },
        };
        const storage = { ...base,
          getItem(name, ...args) {
            if (name === key) queue.flush();
            const value = base.getItem(name, ...args);
            if (name === key) bridge._gameAutosaveSuspended = false;
            return value;
          },
          setItem(name, value, ...args) {
            if (name === key && bridge._gameAutosaveSuspended) return;
            if (name !== key || !value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, 'state')) {
              if (name === key) queue.flush();
              return base.setItem(name, value, ...args);
            }
            requests++;
            if (pending) mergedRequests++;
            else firstAt = Date.now();
            latestValue = value; pending = true; sequence++;
            clearTimer();
            if (bridge.isClosing) { queue.flush(); return; }
            const debounce = Math.max(0, Number(bridge.config.gameAutosaveDebounceMs));
            const maximum = Math.max(1, Number(bridge.config.gameAutosaveMaxWaitMs));
            timer = setTimeout(() => { timer = null; try { queue.flush(); } catch (_) {} },
              Math.min(debounce, Math.max(0, maximum - (Date.now() - firstAt))));
            bridge.scheduleSqliteFlush();
          },
          removeItem(name, ...args) {
            if (name === key) queue.cancel();
            return base.removeItem(name, ...args);
          },
        };
        store.persist.setOptions({ storage });
        this._gameAutosave = queue;
        return true;
      }
      return false;
    }

    flushPendingGameAutosave(key) {
      if (this._gameAutosave && (key === undefined || key === this._gameAutosave.key || /^tavern-(slot-|auto-d)/.test(key))) {
        return this._gameAutosave.flush();
      }
    }

    cancelPendingGameAutosave(key) {
      if (this._gameAutosave && (key === undefined || key === this._gameAutosave.key)) this._gameAutosave.cancel();
    }

    shouldUseJsonTree(_key, _strValue) {
      // v17: 세이브 데이터 무결성 100% 보장을 위해 json_nodes 트리 분할을 사용하지 않고 모든 키를 kv_store에 원문(inline)으로 원자적 저장합니다.
      return false;
    }

    initDexieDatabase() {
      if (this.dexieDb) return this.dexieDb;
      try {
        const { ClassRef, isExternalDexie } = ensureDexieLoaded();
        this.isExternalDexieLoaded = isExternalDexie;
        const db = new ClassRef(DEXIE_DB_NAME);
        db.version(2).stores({
          kv: 'key, updatedAt',
          nodes: 'id, rootKey, updatedAt',
          meta: 'key',
        });
        this.dexieDb = db;
        return db;
      } catch (err) {
        this.log('Dexie 초기화 오류:', err);
        return null;
      }
    }

    hasUnsavedChanges() {
      if (this._gameAutosave && this._gameAutosave.pending) return true;
      if (this.isNeutralinoConnected()) {
        return Boolean(this.dirtySqliteClear || this.dirtySqliteKeys.size || this.dirtySqliteDeletes.size ||
          this.sqliteFlushPromise || this.lastSaveError || this._storageLoadError);
      }
      return Boolean(
        this.dirtyDexieClear ||
          this.dirtyDexieKeys.size > 0 ||
          this.dirtyDexieDeletes.size > 0 ||
          this.pendingNodeUpsertsDexie.size > 0 ||
          this.pendingNodeDeletesDexie.size > 0 ||
          this.dirtySqliteClear ||
          this.dirtySqliteKeys.size > 0 ||
          this.dirtySqliteDeletes.size > 0 ||
          this.pendingNodeUpsertsSqlite.size > 0 ||
          this.pendingNodeDeletesSqlite.size > 0 ||
          this.dexieFlushPromise !== null ||
          this.sqliteFlushPromise !== null ||
          this.writeLocks.size > 0
      );
    }

    showSavingBackdrop(titleText, subText, options = {}) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return null;

      const rootTarget = document.head || document.documentElement || document.body;
      if (!rootTarget) {
        if (typeof window.addEventListener === 'function' && !this._pendingBackdropDomReady) {
          this._pendingBackdropDomReady = true;
          window.addEventListener(
            'DOMContentLoaded',
            () => {
              this._pendingBackdropDomReady = false;
              if (!this.isClosing && !this.initialized) {
                try {
                  this.showSavingBackdrop(titleText, subText, options);
                } catch (_) {}
              }
            },
            { once: true }
          );
        }
        return null;
      }

      const mode = (options && options.mode) || 'loading';
      const badgeText =
        (options && options.badgeText) ||
        (mode === 'success' ? '확인 완료 ✓' : '세이브 보호 작동 중');

      if (!document.getElementById('__neu-saving-backdrop-style')) {
        const styleEl = document.createElement('style');
        styleEl.id = '__neu-saving-backdrop-style';
        styleEl.textContent = `
          @keyframes __neu_circular_rotate {
            100% { transform: rotate(360deg); }
          }
          @keyframes __neu_circular_dash {
            0% { stroke-dasharray: 1, 150; stroke-dashoffset: 0; }
            50% { stroke-dasharray: 90, 150; stroke-dashoffset: -35; }
            100% { stroke-dasharray: 90, 150; stroke-dashoffset: -124; }
          }
          @keyframes __neu_bar_slide {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(250%); }
          }
          #__neu-saving-backdrop {
            position: fixed !important;
            inset: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            z-index: 2147483647 !important;
            background: rgba(6, 10, 19, 0.88) !important;
            backdrop-filter: blur(10px) !important;
            -webkit-backdrop-filter: blur(10px) !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            user-select: none !important;
            pointer-events: all !important;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Malgun Gothic", "맑은 고딕", sans-serif !important;
            opacity: 1;
            transition: opacity 0.22s ease;
          }
          #__neu-saving-card {
            background: linear-gradient(145deg, #0f172a 0%, #1e293b 100%);
            border: 1px solid rgba(59, 130, 246, 0.45);
            border-radius: 22px;
            padding: 32px 40px;
            box-shadow: 0 25px 60px rgba(0, 0, 0, 0.8), 0 0 35px rgba(37, 99, 235, 0.18);
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 15px;
            min-width: 340px;
            max-width: 90vw;
            text-align: center;
            transition: border-color 0.2s ease, box-shadow 0.2s ease;
          }
          #__neu-saving-spinner {
            width: 56px;
            height: 56px;
            animation: __neu_circular_rotate 1.5s linear infinite;
          }
          #__neu-saving-spinner circle.track {
            stroke: rgba(148, 163, 184, 0.2);
          }
          #__neu-saving-spinner circle.indicator {
            stroke: #3b82f6;
            stroke-linecap: round;
            animation: __neu_circular_dash 1.35s ease-in-out infinite;
          }
          #__neu-saving-check {
            width: 56px;
            height: 56px;
            border-radius: 9999px;
            background: rgba(16, 185, 129, 0.18);
            border: 2px solid rgba(52, 211, 153, 0.65);
            color: #34d399;
            display: none;
            align-items: center;
            justify-content: center;
            font-size: 28px;
            font-weight: 800;
            box-shadow: 0 0 24px rgba(16, 185, 129, 0.3);
          }
          #__neu-saving-badge {
            font-size: 11px;
            font-weight: 700;
            padding: 4px 11px;
            border-radius: 9999px;
            background: rgba(59, 130, 246, 0.16);
            color: #93c5fd;
            border: 1px solid rgba(59, 130, 246, 0.35);
            letter-spacing: 0.01em;
          }
          #__neu-saving-progress-track {
            width: 100%;
            height: 5px;
            background: rgba(30, 41, 59, 0.95);
            border-radius: 9999px;
            overflow: hidden;
            margin-top: 4px;
          }
          #__neu-saving-progress-bar {
            width: 45%;
            height: 100%;
            background: linear-gradient(90deg, #3b82f6, #60a5fa, #34d399);
            border-radius: 9999px;
            animation: __neu_bar_slide 1.25s ease-in-out infinite;
          }
        `;
        const styleMount = document.head || document.documentElement || document.body;
        if (styleMount && typeof styleMount.appendChild === 'function') {
          try {
            styleMount.appendChild(styleEl);
          } catch (_) {}
        }
      }

      if (this._hideBackdropTimer) {
        clearTimeout(this._hideBackdropTimer);
        this._hideBackdropTimer = null;
      }

      const allBackdrops =
        typeof document.querySelectorAll === 'function'
          ? Array.from(document.querySelectorAll('#__neu-saving-backdrop'))
          : [];
      for (let i = 1; i < allBackdrops.length; i++) {
        try {
          allBackdrops[i].remove();
        } catch (_) {}
      }
      let backdrop = allBackdrops[0] || document.getElementById('__neu-saving-backdrop');
      if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.id = '__neu-saving-backdrop';
        backdrop.setAttribute('role', 'dialog');
        backdrop.setAttribute('aria-live', 'assertive');
        backdrop.innerHTML = `
          <div id="__neu-saving-card">
            <div id="__neu-saving-badge"></div>
            <svg id="__neu-saving-spinner" viewBox="0 0 50 50">
              <circle class="track" cx="25" cy="25" r="20" fill="none" stroke-width="4.5"></circle>
              <circle class="indicator" cx="25" cy="25" r="20" fill="none" stroke-width="4.5"></circle>
            </svg>
            <div id="__neu-saving-check">✓</div>
            <div id="__neu-saving-title" style="font-size:18px;font-weight:700;color:#f8fafc;letter-spacing:-0.01em;"></div>
            <div id="__neu-saving-sub" style="font-size:13px;font-weight:500;color:#94a3b8;line-height:1.55;max-width:380px;"></div>
            <div id="__neu-saving-progress-track">
              <div id="__neu-saving-progress-bar"></div>
            </div>
          </div>
        `;
        const backdropMount = document.body || document.documentElement || document.head;
        if (backdropMount && typeof backdropMount.appendChild === 'function') {
          try {
            backdropMount.appendChild(backdrop);
          } catch (_) {}
        } else {
          return null;
        }

        if (!document.body && typeof window.addEventListener === 'function') {
          window.addEventListener(
            'DOMContentLoaded',
            () => {
              const all =
                typeof document.querySelectorAll === 'function'
                  ? Array.from(document.querySelectorAll('#__neu-saving-backdrop'))
                  : [];
              for (let i = 1; i < all.length; i++) {
                try {
                  all[i].remove();
                } catch (_) {}
              }
              const el = all[0] || document.getElementById('__neu-saving-backdrop');
              if (el && document.body && el.parentNode !== document.body) {
                document.body.appendChild(el);
              }
            },
            { once: true }
          );
        }
      } else if (document.body && backdrop.parentNode !== document.body) {
        document.body.appendChild(backdrop);
      }

      backdrop.style.opacity = '1';

      const cardEl = document.getElementById('__neu-saving-card');
      const badgeEl = document.getElementById('__neu-saving-badge');
      const spinnerEl = document.getElementById('__neu-saving-spinner');
      const checkEl = document.getElementById('__neu-saving-check');
      const titleEl = document.getElementById('__neu-saving-title');
      const subEl = document.getElementById('__neu-saving-sub');
      const barEl = document.getElementById('__neu-saving-progress-bar');

      const hasNumericProgress =
        typeof options.progress === 'number' && Number.isFinite(options.progress);
      const clampedProgress = hasNumericProgress
        ? Math.max(4, Math.min(100, Math.round(options.progress)))
        : null;

      if (badgeEl) {
        badgeEl.textContent = badgeText;
        if (mode === 'success') {
          badgeEl.style.background = 'rgba(16, 185, 129, 0.18)';
          badgeEl.style.color = '#6ee7b7';
          badgeEl.style.borderColor = 'rgba(52, 211, 153, 0.45)';
        } else if (mode === 'warning') {
          badgeEl.style.background = 'rgba(245, 158, 11, 0.18)';
          badgeEl.style.color = '#fcd34d';
          badgeEl.style.borderColor = 'rgba(251, 191, 36, 0.45)';
        } else if (mode === 'error') {
          badgeEl.style.background = 'rgba(244, 63, 94, 0.18)';
          badgeEl.style.color = '#fda4af';
          badgeEl.style.borderColor = 'rgba(251, 113, 133, 0.45)';
        } else {
          badgeEl.style.background = 'rgba(59, 130, 246, 0.16)';
          badgeEl.style.color = '#93c5fd';
          badgeEl.style.borderColor = 'rgba(59, 130, 246, 0.35)';
        }
      }
      if (cardEl) {
        if (mode === 'success') {
          cardEl.style.borderColor = 'rgba(52, 211, 153, 0.55)';
          cardEl.style.boxShadow = '0 25px 60px rgba(0, 0, 0, 0.8), 0 0 35px rgba(16, 185, 129, 0.22)';
        } else if (mode === 'warning') {
          cardEl.style.borderColor = 'rgba(251, 191, 36, 0.5)';
          cardEl.style.boxShadow = '0 25px 60px rgba(0, 0, 0, 0.8), 0 0 35px rgba(245, 158, 11, 0.2)';
        } else if (mode === 'error') {
          cardEl.style.borderColor = 'rgba(251, 113, 133, 0.55)';
          cardEl.style.boxShadow = '0 25px 60px rgba(0, 0, 0, 0.8), 0 0 35px rgba(244, 63, 94, 0.22)';
        } else {
          cardEl.style.borderColor = 'rgba(59, 130, 246, 0.45)';
          cardEl.style.boxShadow = '0 25px 60px rgba(0, 0, 0, 0.8), 0 0 35px rgba(37, 99, 235, 0.18)';
        }
      }
      if (spinnerEl && checkEl) {
        if (mode === 'success' || mode === 'warning' || mode === 'error') {
          spinnerEl.style.display = 'none';
          checkEl.style.display = 'flex';
          if (mode === 'warning') {
            checkEl.textContent = '!';
            checkEl.style.background = 'rgba(245, 158, 11, 0.18)';
            checkEl.style.borderColor = 'rgba(251, 191, 36, 0.65)';
            checkEl.style.color = '#fbbf24';
            checkEl.style.boxShadow = '0 0 24px rgba(245, 158, 11, 0.28)';
          } else if (mode === 'error') {
            checkEl.textContent = '✕';
            checkEl.style.background = 'rgba(244, 63, 94, 0.18)';
            checkEl.style.borderColor = 'rgba(251, 113, 133, 0.65)';
            checkEl.style.color = '#fb7185';
            checkEl.style.boxShadow = '0 0 24px rgba(244, 63, 94, 0.28)';
          } else {
            checkEl.textContent = '✓';
            checkEl.style.background = 'rgba(16, 185, 129, 0.18)';
            checkEl.style.borderColor = 'rgba(52, 211, 153, 0.65)';
            checkEl.style.color = '#34d399';
            checkEl.style.boxShadow = '0 0 24px rgba(16, 185, 129, 0.3)';
          }
        } else {
          spinnerEl.style.display = 'block';
          checkEl.style.display = 'none';
        }
      }
      if (barEl) {
        if (mode === 'success') {
          barEl.style.width = '100%';
          barEl.style.animation = 'none';
          barEl.style.transition = 'width 0.2s ease';
          barEl.style.background = '#10b981';
        } else if (mode === 'warning') {
          barEl.style.width = '100%';
          barEl.style.animation = 'none';
          barEl.style.transition = 'width 0.2s ease';
          barEl.style.background = '#f59e0b';
        } else if (mode === 'error') {
          barEl.style.width = '100%';
          barEl.style.animation = 'none';
          barEl.style.transition = 'width 0.2s ease';
          barEl.style.background = '#f43f5e';
        } else if (clampedProgress !== null) {
          barEl.style.animation = 'none';
          barEl.style.transition = 'width 0.18s ease';
          barEl.style.width = `${clampedProgress}%`;
          barEl.style.background = 'linear-gradient(90deg, #3b82f6, #60a5fa, #34d399)';
        } else {
          barEl.style.transition = 'none';
          barEl.style.width = '45%';
          barEl.style.animation = '__neu_bar_slide 1.25s ease-in-out infinite';
          barEl.style.background = 'linear-gradient(90deg, #3b82f6, #60a5fa, #34d399)';
        }
      }
      if (titleEl) {
        titleEl.textContent = titleText || '데이터 저장 중...';
      }
      if (subEl) {
        subEl.style.whiteSpace = 'pre-line';
        subEl.textContent =
          subText || '변경된 세이브 데이터를 안전하게 저장하고 있습니다. 잠시만 기다려 주세요.';
      }
      return backdrop;
    }

    showActionToast(message, isError = false) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return;
      if (typeof window.__onLauncherShowToast === 'function') {
        try {
          window.__onLauncherShowToast(message, isError);
          return;
        } catch (_) {}
      }
      try {
        let toastEl = document.getElementById('__neu-action-floating-toast');
        if (!toastEl) {
          toastEl = document.createElement('div');
          toastEl.id = '__neu-action-floating-toast';
          const toastMount = document.body || document.documentElement;
          if (!toastMount) return;
          toastMount.appendChild(toastEl);
        }
        toastEl.style.cssText = [
          'position:fixed',
          'right:18px',
          'bottom:18px',
          'z-index:2147483646',
          'max-width:440px',
          'padding:12px 16px',
          'border-radius:13px',
          'font-family:"Inter",-apple-system,BlinkMacSystemFont,"Malgun Gothic","맑은 고딕",sans-serif',
          'font-size:13px',
          'font-weight:600',
          'line-height:1.45',
          'box-shadow:0 16px 38px rgba(0,0,0,0.75)',
          'border:1px solid ' + (isError ? 'rgba(244,63,94,0.55)' : 'rgba(16,185,129,0.55)'),
          'background:' + (isError ? 'rgba(69,10,20,0.95)' : 'rgba(6,46,34,0.95)'),
          'color:' + (isError ? '#fecdd3' : '#a7f3d0'),
          'pointer-events:auto',
          'cursor:pointer',
          'transition:opacity 0.25s ease',
          'opacity:1',
        ].join(';');
        toastEl.textContent = (isError ? '⚠️ ' : '✅ ') + String(message || '');
        toastEl.onclick = () => {
          toastEl.style.opacity = '0';
        };
        if (this._actionToastTimer) clearTimeout(this._actionToastTimer);
        this._actionToastTimer = setTimeout(() => {
          if (toastEl) toastEl.style.opacity = '0';
        }, 4000);
      } catch (_) {}
    }

    async waitForBackdropPaint(extraMs = 60) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        const fallbackTimer = setTimeout(finish, Math.max(80, Number(extraMs || 60) + 60));
        if (typeof requestAnimationFrame === 'function') {
          try {
            requestAnimationFrame(() => {
              setTimeout(() => {
                clearTimeout(fallbackTimer);
                finish();
              }, extraMs);
            });
          } catch (_) {
            setTimeout(finish, extraMs);
          }
        } else {
          setTimeout(finish, extraMs);
        }
      });
    }

    hideSavingBackdrop(fadeMs = 180) {
      if (typeof document === 'undefined') return;
      const getAllBackdrops = () => {
        const list =
          typeof document.querySelectorAll === 'function'
            ? Array.from(document.querySelectorAll('#__neu-saving-backdrop'))
            : [];
        const single = document.getElementById('__neu-saving-backdrop');
        if (single && !list.includes(single)) list.push(single);
        return list;
      };
      const backdrops = getAllBackdrops();
      if (backdrops.length === 0) return;
      if (!fadeMs || fadeMs <= 0) {
        for (const el of backdrops) {
          try {
            el.remove();
          } catch (_) {}
        }
        return;
      }
      for (const el of backdrops) {
        try {
          el.style.opacity = '0';
          el.style.pointerEvents = 'none';
        } catch (_) {}
      }
      if (this._hideBackdropTimer) clearTimeout(this._hideBackdropTimer);
      this._hideBackdropTimer = setTimeout(() => {
        this._hideBackdropTimer = null;
        for (const el of getAllBackdrops()) {
          try {
            el.remove();
          } catch (_) {}
        }
      }, fadeMs);
    }

    isNeutralinoConnected() {
      ensureNeutralinoEnvironment();
      return Boolean(
        this.config.customFs ||
          this.customSqliteStore ||
          typeof global.NL_PORT !== 'undefined' ||
          isLocalNeutralinoUrl() ||
          (global.Neutralino && global.Neutralino.filesystem)
      );
    }

    async probeRunningSqliteDaemonViaHttp() {
      if (this.customSqliteStore) {
        this.sqliteConnected = true;
        this.sqliteBackendName = 'custom-sqlite';
        return true;
      }
      if (this.sqliteEndpointUrl) {
        const pingRes = await this.callSqliteExtension('ping', {}, 800);
        if (pingRes && pingRes.ok) {
          this.sqliteConnected = true;
          this.sqliteBackendName = pingRes.backend || this.sqliteBackendName || 'sqlite3';
          return true;
        }
      }
      const primaryBaseUrl = this.config.httpStorageBaseUrl || '/userdata';
      const epFile = this.config.sqliteEndpointFileName || 'sqlite-endpoint.json';
      const urlCandidates = [
        `${primaryBaseUrl}/${epFile}`,
        `/userdata/${epFile}`,
        `./userdata/${epFile}`,
      ];
      const tried = new Set();
      for (const u of urlCandidates) {
        if (!u || tried.has(u)) continue;
        tried.add(u);
        let rawEp = null;
        if (typeof fetch === 'function' && typeof window !== 'undefined' && window.location && window.location.protocol.startsWith('http')) {
          try {
            const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const timer = controller ? setTimeout(() => controller.abort(), 700) : null;
            const resp = await fetch(`${u}?_t=${Date.now()}`, {
              method: 'GET',
              cache: 'no-store',
              signal: controller ? controller.signal : undefined,
            });
            if (timer) clearTimeout(timer);
            if (resp && resp.ok && resp.status === 200) {
              rawEp = await resp.text();
            }
          } catch (_) {}
        }
        if (!rawEp) {
          rawEp = syncHttpGetText(u, true);
        }
        if (rawEp) {
          try {
            const ep = JSON.parse(rawEp);
            if (ep && ep.url) {
              this.sqliteEndpointUrl = String(ep.url).replace(/\/+$/, '');
              const pingRes = await this.callSqliteExtension('ping', {}, 800);
              if (pingRes && pingRes.ok) {
                this.sqliteConnected = true;
                this.sqliteBackendName = pingRes.backend || ep.backend || 'sqlite3';
                return true;
              }
            }
          } catch (_) {}
        }
      }
      return false;
    }

    get fs() {
      if (this.config.customFs) {
        return this.config.customFs;
      }
      if (!this._smartFsWrapper) {
        const self = this;
        const getNeuFs = () => {
          ensureNeutralinoEnvironment();
          return global.Neutralino && global.Neutralino.filesystem
            ? global.Neutralino.filesystem
            : null;
        };
        const isWsBlocked = () =>
          Boolean(
            global.Neutralino &&
              typeof global.Neutralino.isWsRejected === 'function' &&
              global.Neutralino.isWsRejected()
          );

        const tryHttpFs = async (action, payload, timeoutMs = 15000) => {
          if (!self.sqliteEndpointUrl && !self.customSqliteStore) {
            await self.probeRunningSqliteDaemonViaHttp();
          }
          if (self.sqliteEndpointUrl && !self.customSqliteStore) {
            const res = await self.callSqliteExtension(action, payload, timeoutMs);
            if (res && res.ok) return res;
            if (res && res.error) {
              const err = new Error(res.error);
              err.__fromHttpFs = true;
              throw err;
            }
          }
          return null;
        };

        this._smartFsWrapper = {
          async readFile(path) {
            try {
              const hRes = await tryHttpFs('fsReadFile', { path }, 20000);
              if (hRes && typeof hRes.data === 'string') return hRes.data;
            } catch (e) {
              if (e && e.__fromHttpFs && isWsBlocked()) throw e;
            }
            const neuFs = getNeuFs();
            if (neuFs && !isWsBlocked()) {
              return await neuFs.readFile(path);
            }
            throw new Error(`파일을 읽을 수 없습니다: ${path}`);
          },
          async writeFile(path, data) {
            try {
              const hRes = await tryHttpFs('fsWriteFile', { path, data }, 20000);
              if (hRes && hRes.ok) return true;
            } catch (e) {
              if (e && e.__fromHttpFs && isWsBlocked()) throw e;
            }
            const neuFs = getNeuFs();
            if (neuFs && !isWsBlocked()) {
              return await neuFs.writeFile(path, data);
            }
            throw new Error(`파일을 저장할 수 없습니다: ${path}`);
          },
          async appendFile(path, data) {
            try {
              const hRes = await tryHttpFs('fsAppendFile', { path, data }, 20000);
              if (hRes && hRes.ok) return true;
            } catch (e) {
              if (e && e.__fromHttpFs && isWsBlocked()) throw e;
            }
            const neuFs = getNeuFs();
            if (neuFs && !isWsBlocked()) {
              return await neuFs.appendFile(path, data);
            }
            throw new Error(`파일을 이어쓸 수 없습니다: ${path}`);
          },
          async getStats(path) {
            try {
              const hRes = await tryHttpFs('fsGetStats', { path }, 4000);
              if (hRes && hRes.ok) return hRes;
            } catch (e) {
              if (e && e.__fromHttpFs && isWsBlocked()) throw e;
            }
            const neuFs = getNeuFs();
            if (neuFs && !isWsBlocked()) {
              return await neuFs.getStats(path);
            }
            throw new Error(`파일 정보를 확인할 수 없습니다: ${path}`);
          },
          async createDirectory(path) {
            try {
              const hRes = await tryHttpFs('fsCreateDirectory', { path }, 4000);
              if (hRes && hRes.ok) return true;
            } catch (e) {
              if (e && e.__fromHttpFs && isWsBlocked()) throw e;
            }
            const neuFs = getNeuFs();
            if (neuFs && !isWsBlocked()) {
              return await neuFs.createDirectory(path);
            }
            return false;
          },
          async remove(path) {
            try {
              const hRes = await tryHttpFs('fsRemove', { path }, 4000);
              if (hRes && hRes.ok) return true;
            } catch (e) {
              if (e && e.__fromHttpFs && isWsBlocked()) throw e;
            }
            const neuFs = getNeuFs();
            if (neuFs && !isWsBlocked()) {
              return await neuFs.remove(path);
            }
            return false;
          },
        };
      }
      return this._smartFsWrapper;
    }

    async ensureDir(dirPath) {
      try {
        await this.fs.getStats(dirPath);
      } catch (_) {
        await this.fs.createDirectory(dirPath);
      }
    }

    enqueueFileOp(filePath, asyncTask) {
      const prev = this.writeLocks.get(filePath) || Promise.resolve();
      const next = prev
        .catch(() => {})
        .then(() => asyncTask())
        .finally(() => {
          if (this.writeLocks.get(filePath) === next) {
            this.writeLocks.delete(filePath);
          }
        });
      this.writeLocks.set(filePath, next);
      return next;
    }

    saveSnapshotToWindowName() {
      if (typeof window === 'undefined') return;
      this.flushPendingGameAutosave();
      try {
        // v19: 런처 <-> 게임 화면 이동 시 세이브 데이터('tavern-game', 'tavern-slot-0' 등)가 단 1바이트도 누락되지 않고
        // 게임 스크립트 시작 전에 100% 메모리에 즉시 적용되도록 전체 메모리 스냅샷을 window.name 캐리어에 전달합니다.
        const payload = JSON.stringify({
          __v__: BRIDGE_VERSION,
          __updatedAt__: this.lastModifiedAt,
          hasOmittedLargeKeys: true,
          commitId: this._sqliteBaseId || null,
          sqliteEndpointUrl: this.sqliteEndpointUrl || null,
          sqliteBackendName: this.sqliteBackendName || null,
          launcherConfig: this.launcherConfig,

        });
        window.name = WINDOW_NAME_PREFIX + payload;
      } catch (_) {}
    }

    restoreSnapshotFromWindowName() {
      if (typeof window === 'undefined' || typeof window.name !== 'string') return false;
      if (!window.name.startsWith(WINDOW_NAME_PREFIX)) return false;
      try {
        const rawJson = window.name.slice(WINDOW_NAME_PREFIX.length);
        const parsed = JSON.parse(rawJson);
        if (!parsed || typeof parsed !== 'object') return false;

        if (parsed.__updatedAt__) {
          this.lastModifiedAt = Number(parsed.__updatedAt__) || Date.now();
        }
        if (parsed.launcherConfig && typeof parsed.launcherConfig === 'object') {
          this.launcherConfig = { ...this.launcherConfig, ...parsed.launcherConfig };
        }
        if (parsed.sqliteEndpointUrl && !this.sqliteEndpointUrl) {
          this.sqliteEndpointUrl = String(parsed.sqliteEndpointUrl).replace(/\/+$/, '');
        }
        if (parsed.sqliteBackendName && !this.sqliteBackendName) {
          this.sqliteBackendName = String(parsed.sqliteBackendName);
        }
        if (parsed.data && typeof parsed.data === 'object') {
          for (const [k, v] of Object.entries(parsed.data)) {
            this.memory.set(k, String(v));
          }
        }
        this._carrierCommitId = parsed.commitId || null;
        this._windowNameHadOmittedLargeKeys = Boolean(parsed.hasOmittedLargeKeys);
        const complete = this.memory.size > 0 && !this._windowNameHadOmittedLargeKeys;
        if (complete) {
          this._loadedFromWindowNameCarrier = true;
        }
        return complete;
      } catch (_) {
        return false;
      }
    }

    async callSqlitePutRaw(key, strValue, meta = {}, timeoutMs = 60000) {
      if (!this.sqliteEndpointUrl || typeof fetch !== 'function' || this.customSqliteStore) {
        return null;
      }
      try {
        const controller =
          typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
        const val = typeof strValue === 'string' ? strValue : String(strValue ?? '');
        const qs = [
          `key=${encodeURIComponent(key)}`,
          `charLen=${val.length}`,
          `revision=${Number(meta.revision || this.revision || 1)}`,
          `updatedAt=${Number(meta.updatedAt || this.lastModifiedAt || Date.now())}`,
          `checkpoint=${meta.checkpoint ? '1' : '0'}`,
        ].join('&');
        const resp = await fetch(`${this.sqliteEndpointUrl}/put-raw?${qs}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: val,
          signal: controller ? controller.signal : undefined,
        });
        if (timer) clearTimeout(timer);
        if (resp.ok) {
          const json = await resp.json();
          if (json && json.ok && json.rawSaved === true) {
            this.sqliteConnected = true;
            if (json.backend) this.sqliteBackendName = json.backend;
            return json;
          }
        }
        this.sqliteConnected = false;
      } catch (_) {
        this.sqliteConnected = false;
      }
      return null;
    }

    async callSqliteGetRaw(key, timeoutMs = 30000) {
      if (!this.sqliteEndpointUrl || typeof fetch !== 'function' || this.customSqliteStore) {
        return null;
      }
      try {
        const controller =
          typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
        const resp = await fetch(
          `${this.sqliteEndpointUrl}/get-raw?key=${encodeURIComponent(key)}`,
          {
            method: 'GET',
            cache: 'no-store',
            signal: controller ? controller.signal : undefined,
          }
        );
        if (timer) clearTimeout(timer);
        if (resp.ok && resp.status === 200) {
          this.sqliteConnected = true;
          return await resp.text();
        }
      } catch (_) {}
      return null;
    }

    async callSqliteExtension(action, payload = {}, timeoutMs = 4000) {
      this._lastSqliteError = null;
      if (this.customSqliteStore) {
        return await this.customSqliteStore(action, payload);
      }

      if (this.sqliteEndpointUrl && typeof fetch === 'function') {
        try {
          const controller =
            typeof AbortController !== 'undefined' ? new AbortController() : null;
          const timer = controller
            ? setTimeout(() => controller.abort(), timeoutMs)
            : null;
          const resp = await fetch(`${this.sqliteEndpointUrl}/rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify({ action, payload }),
            signal: controller ? controller.signal : undefined,
          });
          if (timer) clearTimeout(timer);
          if (resp.ok) {
            const json = await resp.json();
            if (json && json.ok) {
              if (action !== 'shutdown') {
                this.sqliteConnected = true;
              } else {
                this.sqliteConnected = false;
              }
              if (json.backend) this.sqliteBackendName = json.backend;
              return json;
            }
            if (json && json.error) {
              this._lastSqliteError = String(json.error);
              return json;
            }
          }
          this.sqliteConnected = false;
        } catch (err) {
          this.sqliteConnected = false;
          this._lastSqliteError = err.message;
        }
      }

      return null;
    }

    async shutdownSqliteExtension() {
      // Shut down only this app's daemon, after the final verified commit.
      if (this.sqliteEndpointUrl || this.customSqliteStore) {
        const result = await this.callSqliteExtension('shutdown', { deleteBinary: false, killParent: false }, 5000);
        if (!result || !result.ok) throw new Error('저장 서버 종료를 확인하지 못했습니다. 다시 시도해 주세요.');
      }
      this.sqliteConnected = false;
      this.sqliteEndpointUrl = null;
    }

    async patchNeutralinoConfigForExtensionAndSafeClose() {
      if (!this.isNeutralinoConnected() || this.config.customFs) return;
      const appRoot = getAppRootDir();
      const cfgCandidates = [
        joinPath(global.NL_PATH || '.', 'neutralino.config.json'),
        joinPath(appRoot, 'neutralino.config.json'),
        'neutralino.config.json',
      ];
      const tried = new Set();
      for (const cfgPath of cfgCandidates) {
        if (!cfgPath || tried.has(cfgPath)) continue;
        tried.add(cfgPath);
        try {
          const rawCfg = await this.fs.readFile(cfgPath);
          const parsed = JSON.parse(rawCfg);
          let modified = false;

          if (parsed && typeof parsed === 'object') {
            if (!parsed.modes || typeof parsed.modes !== 'object') {
              parsed.modes = {};
              modified = true;
            }
            if (!parsed.modes.window || typeof parsed.modes.window !== 'object') {
              parsed.modes.window = {};
              modified = true;
            }
            if (parsed.modes.window.exitProcessOnClose !== false) {
              parsed.modes.window.exitProcessOnClose = false;
              modified = true;
            }
            if (parsed.exportAuthInfo !== true) {
              parsed.exportAuthInfo = true;
              modified = true;
            }
            if (parsed.tokenSecurity !== 'none') {
              parsed.tokenSecurity = 'none';
              modified = true;
            }
            if (!parsed.port || Number(parsed.port) === 0) {
              parsed.port = 49284;
              modified = true;
            }
            if (!parsed.cli || typeof parsed.cli !== 'object') {
              parsed.cli = {};
              modified = true;
            }
            if (parsed.cli.clientLibrary !== '/neutralino.js') {
              parsed.cli.clientLibrary = '/neutralino.js';
              modified = true;
            }
            const requiredAllow = ['app.*', 'os.*', 'filesystem.*', 'window.*', 'events.*', 'extensions.*', 'storage.*'];
            if (!Array.isArray(parsed.nativeAllowList)) {
              parsed.nativeAllowList = requiredAllow;
              modified = true;
            } else {
              for (const perm of requiredAllow) {
                if (!parsed.nativeAllowList.includes(perm)) {
                  parsed.nativeAllowList.push(perm);
                  modified = true;
                }
              }
            }
            if (Array.isArray(parsed.extensions)) {
              const filtered = parsed.extensions.filter(
                (e) => !e || e.id !== SQLITE_EXTENSION_ID
              );
              if (filtered.length !== parsed.extensions.length) {
                parsed.extensions = filtered;
                modified = true;
              }
            }
            if (modified) {
              await this.fs.writeFile(cfgPath, JSON.stringify(parsed, null, 2));
            }
            break;
          }
        } catch (_) {}
      }
    }

    async _fileExistsNonEmpty(filePath) {
      try {
        const st = await this.fs.getStats(filePath);
        return Boolean(st && st.isFile && Number(st.size || 0) > 0);
      } catch (_) {
        return false;
      }
    }

    async compileSqliteExtensionExeIfNeeded(targetExtDir = 'extensions/sqlite', forceRecompile = false) {
      const exePath = joinPath(targetExtDir, 'neu-sqlite-ext.exe');
      const versionPath = joinPath(targetExtDir, 'ext-version.txt');
      if (!forceRecompile && await this._fileExistsNonEmpty(exePath)) {
        try { if (String(await this.fs.readFile(versionPath)).trim() === String(SQLITE_EXT_VERSION)) return true; } catch (_) {}
      }
      if (!global.Neutralino || !global.Neutralino.os || typeof global.Neutralino.os.execCommand !== 'function') return false;
      if (!(global.NL_OS || inferOsFromNavigator()).toLowerCase().includes('win')) return false;
      const root = getAppRootDir().replace(/\//g, '\\');
      const script = joinPath(/^(?:[A-Za-z]:|\/)/.test(targetExtDir) ? targetExtDir : joinPath(root, targetExtDir), 'run-extension.cmd').replace(/\//g, '\\');
      const result = await global.Neutralino.os.execCommand(`cmd /c call "${script}" --compile-only`);
      if (!result || Number(result.exitCode) !== 0 || !await this._fileExistsNonEmpty(exePath)) {
        const message = `SQLite 확장 컴파일 실패: ${result && (result.stdErr || result.stdOut) || 'extensions/sqlite/compile.log를 확인하세요.'}`;
        this.lastSaveError = message;
        console.error('[NeutralinoStorageBridge]', message);
        return false;
      }
      await this.fs.writeFile(versionPath, String(SQLITE_EXT_VERSION));
      return true;
    }

    async autoEnsureExtensionsAndUserdataFolders() {
      if (!this.isNeutralinoConnected()) return false;
      if (this._ensureFoldersPromise) {
        return await this._ensureFoldersPromise;
      }
      this._ensureFoldersPromise = (async () => {
        try {
          const basePath = this.config.storageDir || joinPath(global.NL_PATH || '.', 'userdata');
          this.storageDir = basePath;
          this.sqliteDbPath = joinPath(this.storageDir, this.config.sqliteDbFileName);
          this.sqliteEndpointPath = joinPath(this.storageDir, this.config.sqliteEndpointFileName);
          this.legacyMainFilePath = joinPath(this.storageDir, this.config.legacyMainFileName);
          this.launcherConfigPath = joinPath(this.storageDir, this.config.launcherConfigFileName);

          const appRoot = getAppRootDir();
          const userdataDirs = new Set([this.storageDir, 'userdata', './userdata']);
          if (appRoot && appRoot !== '.') {
            userdataDirs.add(joinPath(appRoot, 'userdata'));
          }
          for (const uDir of userdataDirs) {
            try {
              await this.ensureDir(uDir);
            } catch (_) {}
          }

          const sources = getSqliteExtensionSources();
          const extDirCandidates = ['extensions/sqlite'];
          if (appRoot && appRoot !== '.') {
            extDirCandidates.push(joinPath(appRoot, 'extensions', 'sqlite'));
          }

          let activeExtDir = 'extensions/sqlite';
          let wroteAny = false;
          let needsRecompile = false;
          for (const candidateExtDir of extDirCandidates) {
            try {
              const parentExtDir = dirname(candidateExtDir);
              await this.ensureDir(parentExtDir);
              await this.ensureDir(candidateExtDir);

              let currentVer = '';
              try {
                currentVer = String(
                  (await this.fs.readFile(joinPath(candidateExtDir, 'ext-version.txt'))) || ''
                ).trim();
              } catch (_) {}
              const isVerMatch = currentVer === String(SQLITE_EXT_VERSION);
              if (!isVerMatch) {
                needsRecompile = true;
              }

              const filesToEnsure = [
                ['NeuSqliteExtension.cs', sources.csharpSource],
                ['main.py', sources.pythonSource],
                ['run-extension.cmd', sources.cmdLauncher],
                ['run-extension.sh', sources.shLauncher],
              ];
              for (const [fName, fContent] of filesToEnsure) {
                const fPath = joinPath(candidateExtDir, fName);
                const existsOk = await this._fileExistsNonEmpty(fPath);
                if (!existsOk || !isVerMatch) {
                  await this.fs.writeFile(fPath, fContent);
                }
              }
              activeExtDir = candidateExtDir;
              wroteAny = true;
              break;
            } catch (_) {}
          }

          await this.compileSqliteExtensionExeIfNeeded(activeExtDir, needsRecompile);

          return wroteAny;
        } finally {
          this._ensureFoldersPromise = null;
        }
      })();
      return await this._ensureFoldersPromise;
    }

    storageKeys() {
      const keys = new Set(this.dirtySqliteClear ? [] : Array.from(this._chunkManifests || [], ([key]) => key));
      for (const key of this.memory.keys()) keys.add(key);
      for (const key of this.dirtySqliteDeletes) keys.delete(key);
      if (this._gameAutosave && this._gameAutosave.pending) keys.add(this._gameAutosave.key);
      return Array.from(keys);
    }

    readStorageValueSync(key) {
      this.flushPendingGameAutosave(key);
      if (this.memory.has(key)) return this.memory.get(key);
      const manifest = this._metadataOnly && !this.dirtySqliteClear && !this.dirtySqliteDeletes.has(key) && this._chunkManifests && this._chunkManifests.get(key);
      if (!manifest) return null;
      try {
        const utf16 = manifest.encoding === 'utf16le';
        let value = syncHttpGetText(`${this.sqliteEndpointUrl}/${utf16 ? 'get-text' : 'get-raw'}?key=${encodeURIComponent(key)}&saveId=${encodeURIComponent(this._sqliteBaseId)}`, false);
        if (utf16 && value !== null) value = JSON.parse(value);
        if (value === null || value === undefined || value.length !== manifest.chars) throw new Error('세이브 읽기 검증에 실패했습니다. 다시 불러와 주세요.');
        this.memory.set(key, value); return value;
      } catch (error) {
        this._storageLoadError = error; this.lastSaveError = error.message; throw error;
      }
    }

    chunkWorker() {
      if (!this._chunkWorkerClient) this._chunkWorkerClient = createStorageChunkWorker();
      return this._chunkWorkerClient;
    }

    async loadChunkValues(meta) {
      const result = new Map(); const id = meta.saveCommit.id;
      for (const [key, manifest] of Object.entries(meta.values)) {
        if (manifest.inline !== undefined) {
          if (!await createStorageChunkCodec().verify(manifest)) throw new Error('세이브 구성 검증에 실패했습니다.');
          result.set(key, manifest.inline); continue;
        }
        let bytes;
        if (this.customSqliteStore) {
          const response = await this.callSqliteExtension('readChunkBytes', { key, id }, 60000);
          if (!response || !response.ok) throw new Error(response && response.error || '세이브 읽기 실패');
          bytes = Uint8Array.from(atob(response.base64), c => c.charCodeAt(0)).buffer;
        } else {
          const response = await fetch(`${this.sqliteEndpointUrl}/get-raw?key=${encodeURIComponent(key)}&saveId=${encodeURIComponent(id)}`, { cache: 'no-store' });
          if (!response.ok) throw new Error('세이브 읽기 실패');
          bytes = await response.arrayBuffer();
        }
        result.set(key, await this.chunkWorker().call('decode', { bytes, manifest }));
      }
      return result;
    }

    async ensureDataLoaded() {
      if (!this._metadataOnly) return;
      if (this._dataLoadPromise) return await this._dataLoadPromise;
      this._dataLoadPromise = (async () => {
        const meta = await this.callSqliteExtension('chunkMeta', { id: this._sqliteBaseId }, 60000);
        if (!meta || !meta.ok || meta.saveCommit.id !== this._sqliteBaseId) throw new Error('세이브 목록이 변경되었습니다. 다시 불러와 주세요.');
        const values = await this.loadChunkValues(meta);
        for (const [key, value] of values) if (!this.dirtySqliteKeys.has(key) && !this.dirtySqliteDeletes.has(key) && !this.dirtySqliteClear) this.memory.set(key, value);
        this._metadataOnly = false;
      })();
      try { await this._dataLoadPromise; } finally { this._dataLoadPromise = null; }
    }

    async flushChunkSnapshot(options = {}) {
      const run = async () => {
        const started = performance.now();
        const full = this.dirtySqliteClear || !this._verifiedSqliteCommit || this._verifiedSqliteCommit.format !== 22;
        const keys = full ? Array.from(this.memory.keys()) : Array.from(this.dirtySqliteKeys);
        const deletes = Array.from(this.dirtySqliteDeletes);
        if (!full && !keys.length && !deletes.length) return { ok: true, commit: this._verifiedSqliteCommit };
        const values = new Map(this.memory), revision = this.revision;
        const manifests = full ? new Map() : new Map(this._chunkManifests || []);
        const changed = [], chunkSizes = new Map();
        const worker = this.chunkWorker();
        let scannedBytes = 0, encodeMs = 0, uploadedBytes = 0, newChunks = 0;
        try {
          for (const key of deletes) manifests.delete(key);
          for (const key of keys) {
            if (!values.has(key)) continue;
            const encoded = await worker.call('encode', { text: values.get(key) });
            manifests.set(key, encoded.manifest); changed.push(encoded.manifest);
            for (const chunk of encoded.manifest.chunks) chunkSizes.set(chunk.hash, chunk.bytes);
            scannedBytes += encoded.scannedBytes; encodeMs += encoded.elapsedMs;
          }
          const entries = Object.fromEntries(Array.from(manifests, ([key, value]) => [key, value.root]));
          const id = global.crypto.randomUUID();
          const payload = { id, baseId: this._sqliteBaseId || '', revision, updatedAt: this.lastModifiedAt || Date.now(), legacyUpdatedAt: this._legacyImportedAt || 0, entries, manifests: changed };
          if (!this.sqliteConnected && !await this.ensureSqliteExtensionInstalledAndRunning()) throw new Error('SQLite 저장 서버 연결 실패');
          payload.rootHash = await createStorageChunkCodec().snapshotRoot(payload);
          const prepared = await this.callSqliteExtension('prepareChunkSave', payload, 60000);
          if (!prepared || !prepared.ok) throw new Error(prepared && prepared.error || this._lastSqliteError || '조각 저장 준비 실패');
          const missing = prepared.missing || [];
          let group = [], size = 4;
          const send = async () => {
            if (!group.length) return;
            const batch = await worker.call('pack', { hashes: group });
            let response;
            if (this.customSqliteStore) response = await this.callSqliteExtension('putChunkBatch', { id, bytes: Array.from(batch) }, 60000);
            else {
              const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 60000);
              try { const raw = await fetch(`${this.sqliteEndpointUrl}/chunks?id=${encodeURIComponent(id)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: batch, signal: controller.signal }); response = await raw.json(); }
              finally { clearTimeout(timer); }
            }
            if (!response || !response.ok) throw new Error(response && response.error || '세이브 조각 전송 실패');
            uploadedBytes += batch.byteLength; newChunks += group.length; group = []; size = 4;
          };
          for (const hash of missing) {
            if (!chunkSizes.has(hash)) throw new Error('필요한 조각을 찾지 못했습니다. 다시 시도해 주세요.');
            const bytes = chunkSizes.get(hash) + 36;
            if (size + bytes > 1048576 || group.length >= 64) await send();
            group.push(hash); size += bytes;
          }
          await send();
          let response = await this.callSqliteExtension('commitChunkSave', { id }, 60000);
          const originalError = response && response.error || this._lastSqliteError;
          if (!response || !response.ok) {
            const meta = await this.callSqliteExtension('exportMeta', {}, 60000);
            if (meta && meta.ok && meta.saveCommit && meta.saveCommit.id === id) response = { ok: true, commit: meta.saveCommit };
          }
          const commit = response && response.commit;
          if (!response || !response.ok || !commit || commit.id !== id || commit.rootHash !== payload.rootHash || !commit.verified || !this.sameStorageHashes(entries, commit.hashes)) throw new Error(originalError || '세이브 확정 검증 실패');
          this._verifiedSqliteCommit = commit; this._sqliteBaseId = id; this._chunkManifests = manifests;
          this.lastSqliteSyncedAt = Date.now(); this.lastSaveError = null;
          if (this.revision === revision) this.dirtySqliteClear = false;
          for (const key of keys) if (this.memory.has(key) && this.memory.get(key) === values.get(key)) this.dirtySqliteKeys.delete(key);
          for (const key of deletes) if (!this.memory.has(key)) this.dirtySqliteDeletes.delete(key);
          this.lastDeltaBytes = uploadedBytes; this.lastDeltaNodes = newChunks;
          this.chunkMetrics = { scannedBytes, uploadedBytes, newChunks, reusedChunks: chunkSizes.size - newChunks, encodeMs, totalMs: performance.now() - started, worker: worker.worker };
          if (!this._chunkGcTimer) this._chunkGcTimer = setTimeout(() => { this._chunkGcTimer = null; if (!this.isClosing) this.callSqliteExtension('collectChunks', {}, 10000).catch(() => {}); }, 30000);
          return { ok: true, commit };
        } finally { try { await worker.call('release'); } catch (_) { this._chunkWorkerClient = null; } }
      };
      const work = run().catch(error => { this.lastSaveError = error.message; throw error; });
      this.sqliteFlushPromise = work;
      try { return await work; } finally { if (this.sqliteFlushPromise === work) this.sqliteFlushPromise = null; }
    }

    async hashStorageValues(values) {
      if (!global.crypto || !global.crypto.subtle) throw new Error('세이브 검증에 필요한 SHA-256 기능을 사용할 수 없습니다.');
      const hashes = Object.create(null);
      for (const [key, value] of values) {
        const digest = await global.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
        hashes[key] = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      }
      return hashes;
    }

    sameStorageHashes(actual, expected) {
      return Boolean(expected && Object.keys(actual).length === Object.keys(expected).length &&
        Object.keys(actual).every((key) => Object.prototype.hasOwnProperty.call(expected, key) && actual[key] === expected[key]));
    }

    async readLegacySnapshot(loadBlobs = true) {
      let raw;
      try { raw = await this.fs.readFile(this.legacyMainFilePath); }
      catch (err) {
        const detail = `${err && err.code || ''} ${err && err.message || err}`;
        if (/NE_FS_NOPATHE|ENOENT|File not found|No such file|does not exist/i.test(detail)) return null;
        try { await this.fs.getStats(this.legacyMainFilePath); }
        catch (statError) {
          if (/NE_FS_NOPATHE|ENOENT|File not found|No such file|does not exist/i.test(`${statError.code || ''} ${statError.message || statError}`)) return null;
        }
        throw err;
      }
      return await this.parseLegacySnapshot(raw, (name) => this.fs.readFile(joinPath(this.storageDir, name)), loadBlobs);
    }

    async parseLegacySnapshot(raw, readBlob, loadBlobs = true) {
      const parsed = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
      if (!parsed || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data))
        throw new Error('기존 세이브 목록이 손상되었습니다. 원본 파일을 보존하고 복원을 중단합니다.');
      const values = new Map(Object.entries(parsed.data).map(([k, v]) => [k, String(v)]));
      for (const [key, name] of Object.entries(parsed.__external__ || {})) {
        if (typeof name !== 'string' || !/^blob_[a-zA-Z0-9_-]+\.dat$/.test(name)) throw new Error('잘못된 세이브 파일 참조입니다.');
        if (!loadBlobs) continue;
        const value = await readBlob(name);
        if (value === null || value === undefined) throw new Error(`기존 세이브 파일을 읽을 수 없습니다: ${name}`);
        values.set(key, String(value));
        this.externalBlobMap.set(key, name);
      }
      return { values, updatedAt: Number(parsed.__updatedAt__ || 0), revision: Number(parsed.__revision__ || 0), raw };
    }

    async cleanupLegacyDiskFilesIfPresent() {
      // Recovery sources are retained, including after a successful migration.
      return false;
    }

    async flushDirectDiskStorage() {
      // Never overwrite the recovery source after switching to verified SQLite commits.
      return false;
    }

    async ensureSqliteExtensionInstalledAndRunning(forceRestart = false) {
      if (this.customSqliteStore) {
        this.sqliteConnected = true;
        this.sqliteBackendName = 'custom-sqlite';
        return true;
      }
      if (!this.isNeutralinoConnected() || this.config.customFs) return false;

      // 1단계 (HTTP-First): WebSocket(filesystem.readFile)을 전혀 호출하지 않고
      // 현재 메모리의 sqliteEndpointUrl 또는 HTTP(/userdata/sqlite-endpoint.json)로 실행 중인 데몬을 먼저 확인합니다.
      // (페이지 이동이나 새로고침 시 WebSocket 400 핸드셰이크 오류가 발생하는 현상을 원천 차단)
      if (!forceRestart) {
        const isAlive = await this.probeRunningSqliteDaemonViaHttp();
        if (isAlive && this.sqliteEndpointUrl) {
          const pingRes = await this.callSqliteExtension('ping', {}, 800);
          if (pingRes && pingRes.ok) {
            const runningVer = Number(pingRes.version || 0);
            // 버전이 최신(v20+)이거나 현재 페이지에서 WebSocket이 1회용 토큰 제한으로 차단된 상태라면
            // 기존에 실행 중인 SQLite 데몬을 그대로 재사용하여 세이브 읽기/쓰기를 100% 정상 수행합니다.
            if (runningVer >= SQLITE_EXT_VERSION) {
              this.sqliteConnected = true;
              this.sqliteBackendName = pingRes.backend || this.sqliteBackendName || 'sqlite3';
              return true;
            }
          }
        }
      }

      // 2단계: 데몬이 아직 실행 중이지 않거나 강제 재시작이 필요한 경우에만 설정 패치 및 데몬 기동 수행
      const wsBlockedNow = Boolean(
        global.Neutralino &&
          typeof global.Neutralino.isWsRejected === 'function' &&
          global.Neutralino.isWsRejected()
      );
      if (wsBlockedNow && !this.sqliteConnected) {
        return false;
      }

      await this.patchNeutralinoConfigForExtensionAndSafeClose();

      if (!forceRestart) {
        try {
          const rawEp = await this.fs.readFile(this.sqliteEndpointPath);
          const ep = JSON.parse(rawEp);
          if (ep && ep.url) {
            this.sqliteEndpointUrl = String(ep.url).replace(/\/+$/, '');
            const pingRes = await this.callSqliteExtension('ping', {}, 800);
            if (
              pingRes &&
              pingRes.ok &&
              Number(pingRes.version || ep.version || 0) >= SQLITE_EXT_VERSION
            ) {
              this.sqliteConnected = true;
              this.sqliteBackendName = pingRes.backend || ep.backend || 'sqlite3';
              return true;
            }
            // 구버전 데몬이 응답한 경우 즉시 종료 후 재구동
            await this.shutdownSqliteExtension();
          }
        } catch (_) {}
      } else {
        await this.shutdownSqliteExtension();
      }

      const appRoot = getAppRootDir();
      const isWin = (global.NL_OS || inferOsFromNavigator()).toLowerCase().includes('win');

      await this.autoEnsureExtensionsAndUserdataFolders();

      if (
        global.Neutralino &&
        global.Neutralino.os &&
        typeof global.Neutralino.os.execCommand === 'function'
      ) {
        try {
          if (isWin) {
            const hasCompiledExe =
              (await this._fileExistsNonEmpty('extensions/sqlite/neu-sqlite-ext.exe')) ||
              (appRoot &&
                appRoot !== '.' &&
                (await this._fileExistsNonEmpty(
                  joinPath(appRoot, 'extensions/sqlite/neu-sqlite-ext.exe')
                )));

            const pidArg = global.NL_PID ? ` --parent-pid ${Number(global.NL_PID)}` : '';
            const winRoot = appRoot && appRoot !== '.' ? appRoot.replace(/\//g, '\\') : '';
            if (hasCompiledExe) {
              const launchExeCmd = winRoot
                ? `pushd "${winRoot}" && start "" extensions\\sqlite\\neu-sqlite-ext.exe --app-root "${winRoot}"${pidArg} && popd`
                : `start "" extensions\\sqlite\\neu-sqlite-ext.exe${pidArg}`;
              await global.Neutralino.os.execCommand(launchExeCmd, { background: true });
            } else {
              const launchCmdScript = winRoot
                ? `pushd "${winRoot}" && call extensions\\sqlite\\run-extension.cmd --app-root "${winRoot}"${pidArg} && popd`
                : `call extensions\\sqlite\\run-extension.cmd${pidArg}`;
              await global.Neutralino.os.execCommand(launchCmdScript, { background: true });
            }
          } else {
            const pidArg = global.NL_PID ? ` --parent-pid ${Number(global.NL_PID)}` : '';
            const shPath = joinPath(appRoot, 'extensions', 'sqlite', 'run-extension.sh').replace(
              /"/g,
              '\\"'
            );
            const safeRoot = appRoot.replace(/"/g, '\\"');
            await global.Neutralino.os.execCommand(
              `sh "${shPath}" --app-root "${safeRoot}"${pidArg}`,
              { background: true }
            );
          }
        } catch (_) {}

        for (let attempt = 0; attempt < 15; attempt++) {
          await new Promise((r) => setTimeout(r, 180));
          try {
            if (await this.probeRunningSqliteDaemonViaHttp()) {
              return true;
            }
            const rawEp = await this.fs.readFile(this.sqliteEndpointPath);
            const ep = JSON.parse(rawEp);
            if (ep && ep.url) {
              this.sqliteEndpointUrl = String(ep.url).replace(/\/+$/, '');
              const pingRes = await this.callSqliteExtension('ping', {}, 800);
              if (pingRes && pingRes.ok) {
                this.sqliteConnected = true;
                this.sqliteBackendName = pingRes.backend || ep.backend || 'sqlite3';
                return true;
              }
            }
          } catch (_) {}
        }
      }

      return false;
    }

    async seedNodeHashes(hashesByKey) {
      if (!hashesByKey || typeof hashesByKey !== 'object') return;
      for (const [k, mapObj] of Object.entries(hashesByKey)) {
        if (!mapObj || typeof mapObj !== 'object') continue;
        const m = new Map();
        for (const [p, h] of Object.entries(mapObj)) {
          m.set(p, String(h));
        }
        this.nodeHashesByKey.set(k, m);
        this.nodeCountByKey.set(k, m.size);
      }
      if (this.deltaWorker) {
        try {
          await this.deltaWorker.call('seedHashes', { hashesByKey });
        } catch (_) {}
      }
    }

    ensureReady() {
      ensureNeutralinoEnvironment();
      this.initDexieDatabase();
      if (!this.proxy) {
        this.installProxy();
      }
      this.setupContextMenu();
      if (this.isNeutralinoConnected()) {
        this.setupLifecycleHooks();
        const isLauncherOrExtractorPage =
          Boolean(global.__IS_WAYWARD_LAUNCHER_UI__) ||
          (typeof window !== 'undefined' &&
            window.location &&
            /launcher\.html|extractor/i.test(window.location.pathname || ''));
        if (!this.initialized && !isLauncherOrExtractorPage) {
          if (!this.initPromise && !this._bootstrapComplete) this.bootstrapSyncIfPossible();
          this.init().catch((err) => { this.lastSaveError = err.message; });
        }
      }
    }

    bootstrapSyncIfPossible() {
      ensureNeutralinoEnvironment();
      this.initDexieDatabase();
      this.storageDir = this.config.storageDir || joinPath(global.NL_PATH || '.', 'userdata');
      this.sqliteDbPath = joinPath(this.storageDir, this.config.sqliteDbFileName);
      this.sqliteEndpointPath = joinPath(this.storageDir, this.config.sqliteEndpointFileName);
      this.legacyMainFilePath = joinPath(this.storageDir, this.config.legacyMainFileName);
      this.launcherConfigPath = joinPath(this.storageDir, this.config.launcherConfigFileName);
      if (!this.proxy) this.installProxy();
      const carrier = this.restoreSnapshotFromWindowName();
      if (!this.isNeutralinoConnected()) return carrier;
      this.setupLifecycleHooks();
      if (global.__IS_WAYWARD_LAUNCHER_UI__ || typeof window === 'undefined' || /launcher\.html|extractor/i.test(window.location.pathname || '')) return carrier;
      try {
        const base = this.config.httpStorageBaseUrl || '/userdata';
        const rawLegacy = syncHttpGetText(`${base}/${this.config.legacyMainFileName}`, false);
        const legacy = rawLegacy === null ? null : JSON.parse(rawLegacy.replace(/^\uFEFF/, ''));
        const endpointText = syncHttpGetText(`${base}/${this.config.sqliteEndpointFileName}`, false);
        if (endpointText) this.sqliteEndpointUrl = JSON.parse(endpointText).url;
        let meta = null;
        if (this.sqliteEndpointUrl) {
          const raw = syncHttpGetText(`${this.sqliteEndpointUrl}/export-meta`, false);
          if (raw) meta = JSON.parse(raw);
        }
        const commit = meta && meta.ok && meta.saveCommit;
        const useSqlite = commit && commit.verified === true && (!legacy || Number(legacy.__updatedAt__ || 0) <= Number(commit.legacyUpdatedAt || 0));
        const values = new Map();
        if (useSqlite) {
          if (carrier && this._carrierCommitId === commit.id) {
            this._bootstrapComplete = true;
            return true;
          }
          if (commit.format === 22) {
            const manifests = new Map(Object.entries(meta.values || {}));
            if (manifests.size !== Number(commit.keyCount)) throw new Error('세이브 항목 수가 일치하지 않습니다.');
            this.memory.clear();
            for (const [key, value] of Object.entries(meta.inlineData || {})) this.memory.set(key, String(value));
            this._chunkManifests = manifests;
            this._metadataOnly = true;
            this._verifiedSqliteCommit = commit;
            this._sqliteBaseId = commit.id;
            this._legacyImportedAt = Number(commit.legacyUpdatedAt || 0);
            this.revision = Number(commit.revision || 0);
            this.lastModifiedAt = Number(commit.updatedAt);
            this._loadedFromSqliteAtBootstrap = true;
            this._bootstrapChunkCommitId = commit.id;
            this._bootstrapComplete = true;
            // Keep the catalog synchronous; fetch each large raw value only on its first read.
            return true;
          }
          for (const [k, v] of Object.entries(meta.inlineData || {})) values.set(k, String(v));
          for (const k of meta.largeKeys || []) {
            const manifest = meta.values && meta.values[k];
            const utf16 = manifest && manifest.encoding === 'utf16le';
            let value = syncHttpGetText(`${this.sqliteEndpointUrl}/${utf16 ? 'get-text' : 'get-raw'}?key=${encodeURIComponent(k)}&saveId=${encodeURIComponent(commit.id)}`, false);
            if (utf16 && value !== null) value = JSON.parse(value);
            if (value === null) throw new Error(`세이브 읽기 실패: ${k}`);
            values.set(k, value);
          }
          if (values.size !== Number(commit.keyCount)) throw new Error('세이브 항목 수가 일치하지 않습니다.');
          const after = syncHttpGetText(`${this.sqliteEndpointUrl}/export-meta`, false);
          const afterCommit = after && JSON.parse(after).saveCommit;
          if (!afterCommit || !afterCommit.verified || afterCommit.id !== commit.id) throw new Error('불러오는 동안 세이브가 변경되었습니다. 다시 불러와 주세요.');
          this._loadedFromSqliteAtBootstrap = true;
          if (commit.format === 22) { this._bootstrapChunkCommitId = commit.id; this._chunkManifests = new Map(Object.entries(meta.values)); }
          this.lastModifiedAt = Number(commit.updatedAt);
        } else if (legacy) {
          if (!legacy.data || typeof legacy.data !== 'object') throw new Error('기존 세이브 목록이 손상되었습니다.');
          for (const [k, v] of Object.entries(legacy.data)) values.set(k, String(v));
          for (const [k, name] of Object.entries(legacy.__external__ || {})) {
            if (!/^blob_[a-zA-Z0-9_-]+\.dat$/.test(name)) throw new Error('잘못된 세이브 파일 참조입니다.');
            const value = syncHttpGetText(`${base}/${name}`, false);
            if (value === null) throw new Error(`기존 세이브 파일을 읽을 수 없습니다: ${name}`);
            values.set(k, value);
          }
          this._bootstrapLegacyAt = Number(legacy.__updatedAt__ || 0);
          this._bootstrapLegacyRevision = Number(legacy.__revision__ || 0);
          this.lastModifiedAt = this._bootstrapLegacyAt;
        } else {
          return carrier;
        }
        this.memory.clear();
        for (const [k, v] of values) this.memory.set(k, v);
        this._bootstrapComplete = true;
        return true;
      } catch (err) {
        this._storageLoadError = err;
        this.lastSaveError = err.message;
        return false;
      }
    }

    async init() {
      if (this.initialized) return this.proxy;
      if (this.initPromise) return this.initPromise;
      ensureNeutralinoEnvironment();
      this.initDexieDatabase();
      if (!this.proxy) this.installProxy();
      this.setupContextMenu();
      this.storageDir = this.config.storageDir || joinPath(global.NL_PATH || '.', 'userdata');
      this.sqliteDbPath = joinPath(this.storageDir, this.config.sqliteDbFileName);
      this.sqliteEndpointPath = joinPath(this.storageDir, this.config.sqliteEndpointFileName);
      this.legacyMainFilePath = joinPath(this.storageDir, this.config.legacyMainFileName);
      this.launcherConfigPath = joinPath(this.storageDir, this.config.launcherConfigFileName);
      if (!this.isNeutralinoConnected()) return null;
      this.setupLifecycleHooks();
      const work = (async () => {
        try {
          this._storageLoadError = null;
          let legacy = await this.readLegacySnapshot(false);
          await this.ensureSqliteExtensionInstalledAndRunning();
          if (!this.sqliteConnected) throw new Error(this.lastSaveError || 'SQLite 저장 서버에 연결하지 못했습니다. 기존 세이브는 보존됩니다.');
          try {
            const cfg = await this.fs.readFile(this.launcherConfigPath);
            this.launcherConfig = { ...this.launcherConfig, ...JSON.parse(cfg) };
          } catch (_) {}
          let exported = await this.callSqliteExtension('exportMeta', {}, 60000);
          const chunked = exported && exported.saveCommit && exported.saveCommit.format === 22;
          if (chunked) {
            this._chunkManifests = new Map(Object.entries(exported.values));
            const latestLegacy = legacy && legacy.updatedAt > Number(exported.saveCommit.legacyUpdatedAt || 0);
            const launcher = Boolean(global.__IS_WAYWARD_LAUNCHER_UI__) || typeof window !== 'undefined' && /launcher\.html|extractor/i.test(window.location.pathname || '');
            if (!latestLegacy && launcher && !this.dirtySqliteClear && !this.dirtySqliteKeys.size && !this.dirtySqliteDeletes.size) {
              this._verifiedSqliteCommit = exported.saveCommit; this._sqliteBaseId = exported.saveCommit.id;
              this._legacyImportedAt = Number(exported.saveCommit.legacyUpdatedAt || 0);
              this.revision = Number(exported.saveCommit.revision); this.lastModifiedAt = Number(exported.saveCommit.updatedAt);
              this.memory.clear(); for (const [key,value] of Object.entries(exported.inlineData)) this.memory.set(key,value);
              this._metadataOnly = true; this.initialized = true; this.lastSaveError = null; return this.proxy;
            }
            exported.data = Object.fromEntries(this._bootstrapComplete && this._bootstrapChunkCommitId === exported.saveCommit.id ? this.memory : await this.loadChunkValues(exported));
          } else exported = await this.callSqliteExtension('exportAll', {}, 60000);
          if (!exported || !exported.ok || !exported.data) throw new Error('SQLite 저장 내용을 읽지 못했습니다.');
          const sqliteValues = new Map(Object.entries(exported.data).map(([k, v]) => [k, String(v)]));
          const commit = exported.saveCommit;
          const valid = Boolean(commit && commit.verified === true && (commit.format === 22 || this.sameStorageHashes(await this.hashStorageValues(sqliteValues), commit.hashes)));
          if (!legacy && !valid && !sqliteValues.size && this.dexieDb) {
            await this.dexieDb.open();
            for (const row of await this.dexieDb.kv.toArray()) {
              if (row && typeof row.key === 'string' && row.value !== null && row.value !== undefined) sqliteValues.set(row.key, String(row.value));
            }
          }
          this._sqliteBaseId = commit && commit.id || '';
          this._verifiedSqliteCommit = valid ? commit : null;
          const useLegacy = Boolean(legacy && (!valid || legacy.updatedAt > Number(commit.legacyUpdatedAt || 0)));
          if (useLegacy) legacy = await this.parseLegacySnapshot(legacy.raw, (name) => this.fs.readFile(joinPath(this.storageDir, name)));
          const selected = useLegacy ? legacy.values : sqliteValues;
          const staleBootstrap = this._bootstrapComplete && valid && !useLegacy && (
            this._bootstrapChunkCommitId && this._bootstrapChunkCommitId !== commit.id ||
            this._bootstrapLegacyAt !== undefined && (Number(commit.updatedAt) > this._bootstrapLegacyAt || Number(commit.revision) > Number(this._bootstrapLegacyRevision || 0)));
          if (staleBootstrap) { this._bootstrapComplete = false; this._loadedFromWindowNameCarrier = false; this._awaitingReload = true; }
          // Only overlay writes made after a complete synchronous bootstrap.
          const pending = this._bootstrapComplete || this._loadedFromWindowNameCarrier
            ? new Map(Array.from(this.dirtySqliteKeys).filter((k) => this.memory.has(k)).map((k) => [k, this.memory.get(k)])) : new Map();
          const pendingDeletes = this._bootstrapComplete || this._loadedFromWindowNameCarrier ? Array.from(this.dirtySqliteDeletes) : [];
          const pendingClear = Boolean(this.dirtySqliteClear && (this._bootstrapComplete || this._loadedFromWindowNameCarrier));
          this.memory.clear();
          if (!pendingClear) for (const [k, v] of selected) this.memory.set(k, v);
          for (const k of pendingDeletes) this.memory.delete(k);
          for (const [k, v] of pending) this.memory.set(k, v);
          this._legacyImportedAt = useLegacy ? legacy.updatedAt : Number(commit && commit.legacyUpdatedAt || 0);
          this.revision = Math.max(this.revision, Number(useLegacy ? legacy.revision : commit && commit.revision || 0));
          this.lastModifiedAt = pending.size || pendingDeletes.length || pendingClear ? this.lastModifiedAt || Date.now()
            : Number(useLegacy ? legacy.updatedAt : commit && commit.updatedAt || exported.updatedAt || Date.now());
          this.dirtySqliteKeys.clear(); this.dirtySqliteDeletes.clear();
          for (const [k] of pending) this.dirtySqliteKeys.add(k);
          for (const k of pendingDeletes) this.dirtySqliteDeletes.add(k);
          this.dirtySqliteClear = pendingClear || useLegacy || !valid || this.config.chunkStorage !== false && commit.format !== 22;
          if (this.dirtySqliteClear) for (const k of this.memory.keys()) this.dirtySqliteKeys.add(k);
          await this.flushAll({ checkpoint: true, initializing: true });
          if (useLegacy || !valid || this.config.chunkStorage !== false && commit.format !== 22) {
            const reopened = await this.callSqliteExtension('exportAll', {}, 60000);
            const values = reopened && reopened.data && new Map(Object.entries(reopened.data));
            if (!reopened || !reopened.saveCommit || reopened.saveCommit.id !== this._sqliteBaseId || !values ||
              !this.sameStorageHashes(await this.hashStorageValues(values), (this._verifiedSqliteCommit.format === 22 ? await this.hashStorageValues(this.memory) : this._verifiedSqliteCommit.hashes)))
              throw new Error('이전 후 SQLite 재읽기 검증에 실패했습니다. 기존 파일은 보존됩니다.');
          }
          this.initialized = true;
          this.lastSaveError = null;
          // Reload only if game scripts ran before the complete save became available.
          if (!global.__IS_WAYWARD_LAUNCHER_UI__ && typeof window !== 'undefined' && !/launcher\.html|extractor/i.test(window.location.pathname || '') && !this._bootstrapComplete && !this._loadedFromWindowNameCarrier && this.memory.size) {
            const guard = '__NEU_ASYNC_SQLITE_RELOAD_GUARD_V22__';
            if (!sessionGet(guard)) { this._awaitingReload = true; sessionSet(guard, '1'); this.saveSnapshotToWindowName(); window.location.reload(); }
          }
          return this.proxy;
        } catch (err) {
          this.lastSaveError = err.message;
          this._storageLoadError = err;
          throw err;
        }
      })();
      this.initPromise = work;
      try { return await work; }
      finally { if (!this.initialized) this.initPromise = null; }
    }

    async _checkDiskOrHttpFile(relCandidates, validatorFn = null, options = {}) {
      const appRoot = getAppRootDir();
      const allowResourcesSubdir = options.allowResourcesSubdir !== false;
      const canUseFs =
        Boolean(this.config.customFs) ||
        Boolean(
          global.Neutralino &&
            global.Neutralino.filesystem &&
            (global.NL_TOKEN || global.NL_CONNECT_TOKEN) &&
            !this._fsRpcTimedOut
        );

      const expandedPaths = [];
      for (const rel of relCandidates) {
        if (!rel) continue;
        const cleanRel = String(rel).replace(/^\/+/, '');
        if (appRoot && appRoot !== '.') {
          expandedPaths.push(joinPath(appRoot, cleanRel));
          if (allowResourcesSubdir) {
            expandedPaths.push(joinPath(appRoot, 'resources', cleanRel));
          }
        }
        expandedPaths.push(cleanRel);
        expandedPaths.push(`./${cleanRel}`);
        if (allowResourcesSubdir) {
          expandedPaths.push(joinPath('resources', cleanRel));
          expandedPaths.push(`./${joinPath('resources', cleanRel)}`);
        }
      }

      const triedPaths = new Set();
      if (canUseFs) {
        for (const p of expandedPaths) {
          if (!p || triedPaths.has(p)) continue;
          triedPaths.add(p);
          try {
            const st = await Promise.race([
              this.fs.getStats(p),
              new Promise((_, rej) =>
                setTimeout(() => {
                  this._fsRpcTimedOut = true;
                  rej(new Error('timeout'));
                }, 900)
              ),
            ]);
            if (st && st.isFile) {
              if (Number(st.size || 0) <= 0) {
                return { exists: false, corruptedZeroByte: true, foundPath: p };
              }
              if (typeof validatorFn === 'function') {
                const content = await Promise.race([
                  this.fs.readFile(p),
                  new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1200)),
                ]);
                const validRes = validatorFn(String(content || ''));
                if (!validRes.ok) {
                  return {
                    exists: false,
                    corruptedContent: true,
                    reason: validRes.reason,
                    foundPath: p,
                  };
                }
              }
              return { exists: true, foundPath: p };
            }
          } catch (err) {
            if (this._fsRpcTimedOut) break;
          }
        }
      }

      let lastHttpValidationFailure = null;
      if (!this.config.customFs && typeof fetch === 'function' && typeof window !== 'undefined') {
        const triedUrls = new Set();
        for (const rel of relCandidates) {
          if (!rel) continue;
          const cleanRel = String(rel).replace(/^\/+/, '');
          const urlCandidates = allowResourcesSubdir
            ? [`/${cleanRel}`, `./${cleanRel}`, `/resources/${cleanRel}`]
            : [`/${cleanRel}`, `./${cleanRel}`];
          for (const u of urlCandidates) {
            if (triedUrls.has(u)) continue;
            triedUrls.add(u);
            try {
              const controller =
                typeof AbortController !== 'undefined' ? new AbortController() : null;
              const timer = controller ? setTimeout(() => controller.abort(), 900) : null;
              const resp = await fetch(`${u}?_check=${Date.now()}`, {
                method: 'GET',
                cache: 'no-store',
                signal: controller ? controller.signal : undefined,
              });
              if (timer) clearTimeout(timer);
              if (resp && resp.ok && resp.status === 200) {
                const text = await resp.text();
                if (!text || text.length === 0) {
                  lastHttpValidationFailure = { exists: false, corruptedZeroByte: true, foundPath: u };
                  continue;
                }
                if (typeof validatorFn === 'function') {
                  const validRes = validatorFn(text);
                  if (!validRes.ok) {
                    if (validRes.reason && validRes.reason !== 'HTML 폴백 응답') {
                      lastHttpValidationFailure = {
                        exists: false,
                        corruptedContent: true,
                        reason: validRes.reason,
                        foundPath: u,
                      };
                    }
                    continue;
                  }
                }
                return { exists: true, foundPath: u };
              }
            } catch (_) {}
          }
        }
      }

      return lastHttpValidationFailure || { exists: false };
    }

    async verifyRequiredFiles() {
      ensureNeutralinoEnvironment();
      this._fsRpcTimedOut = false;

      const basePath = this.config.storageDir || joinPath(global.NL_PATH || '.', 'userdata');
      this.storageDir = basePath;
      this.sqliteDbPath = joinPath(this.storageDir, this.config.sqliteDbFileName);
      this.sqliteEndpointPath = joinPath(this.storageDir, this.config.sqliteEndpointFileName);
      this.legacyMainFilePath = joinPath(this.storageDir, this.config.legacyMainFileName);
      this.launcherConfigPath = joinPath(this.storageDir, this.config.launcherConfigFileName);

      const missingFiles = [];
      const extName = this.config.extractorFileName || 'localstorage-extractor.html';

      const notHtmlFallback = (txt) => {
        const trimmed = txt.trimStart().toLowerCase();
        return !trimmed.startsWith('\x3c!doctype') && !trimmed.startsWith('\x3chtml');
      };

      // extensions 및 userdata 폴더는 init()에서 생성/컴파일하므로 verifyRequiredFiles에서는 중복 대기하지 않음

      // 핵심 루트 구성 파일 5종 병렬 검사 (extensions 폴더는 제외하고 자동 생성에만 집중)
      const [
        cfgCheck,
        neuRootCheck,
        neuLegacySubfolderCheck,
        launcherCheck,
        bridgeCheck,
        extractorCheck,
      ] = await Promise.all([
        // 1. neutralino.config.json
        this._checkDiskOrHttpFile(['neutralino.config.json'], (txt) => {
          if (!notHtmlFallback(txt)) return { ok: false, reason: 'HTML 폴백 응답' };
          try {
            const parsed = JSON.parse(txt);
            if (!parsed || typeof parsed !== 'object') {
              return { ok: false, reason: '올바른 JSON 설정 형식이 아닙니다.' };
            }
            this._lastCheckedNeutralinoConfigObj = parsed;
            const cl = parsed.cli && parsed.cli.clientLibrary ? String(parsed.cli.clientLibrary) : '';
            const hasTokenNow = Boolean(global.NL_TOKEN || global.NL_CONNECT_TOKEN || this.config.customFs);
            if (!hasTokenNow && /js\/neutralino\.js/i.test(cl)) {
              return {
                ok: false,
                configClientLibraryMismatch: true,
                reason: `clientLibrary 경로가 구버전("${cl}")으로 되어 있어 neutralino.js 토큰 주입이 차단되었습니다.`,
              };
            }
            return { ok: true };
          } catch (_) {
            return { ok: false, reason: 'JSON 구문이 손상되었습니다.' };
          }
        }),

        // 2a. neutralino.js (실행 파일 .exe와 같은 폴더: ./neutralino.js)
        this._checkDiskOrHttpFile(
          ['neutralino.js'],
          (txt) => {
            if (!notHtmlFallback(txt)) return { ok: false, reason: 'HTML 폴백 응답' };
            return {
              ok: txt.includes('Neutralino') || txt.includes('NL_'),
              reason: 'Neutralino 클라이언트 라이브러리 내용이 올바르지 않습니다.',
            };
          },
          { allowResourcesSubdir: true }
        ),

        // 2b. 구버전 위치(js/neutralino.js)에 남아 있는지 확인용
        this._checkDiskOrHttpFile(
          ['js/neutralino.js'],
          (txt) => {
            if (!notHtmlFallback(txt)) return { ok: false, reason: 'HTML 폴백 응답' };
            return { ok: txt.includes('Neutralino') || txt.includes('NL_') };
          },
          { allowResourcesSubdir: true }
        ),

        // 3. launcher.html
        this._checkDiskOrHttpFile(['launcher.html'], (txt) => ({
          ok:
            txt.includes('__IS_WAYWARD_LAUNCHER_UI__') ||
            txt.includes('Wayward Tavern') ||
            txt.includes('btn-launch-game'),
          reason: '런처 화면 코드가 올바르지 않습니다.',
        })),

        // 4. neutralino-storage-bridge.js
        this._checkDiskOrHttpFile(['neutralino-storage-bridge.js'], (txt) => {
          if (!notHtmlFallback(txt)) return { ok: false, reason: 'HTML 폴백 응답' };
          return {
            ok: txt.includes('NeutralinoStorageBridge'),
            reason: '저장소 엔진 스크립트 내용이 올바르지 않습니다.',
          };
        }),

        // 5. localstorage-extractor.html
        this._checkDiskOrHttpFile([extName], (txt) => ({
          ok:
            txt.includes('localstorage-backup.json') ||
            txt.includes('인터넷 창 세이브') ||
            txt.includes('btn-download-json'),
          reason: '백업 도구 파일 내용이 올바르지 않습니다.',
        })),
      ]);

      if (!cfgCheck.exists) {
        const isClMismatch = Boolean(
          cfgCheck.reason && cfgCheck.reason.includes('clientLibrary')
        );
        missingFiles.push({
          fileName: 'neutralino.config.json',
          expectedPath: './neutralino.config.json',
          role: isClMismatch
            ? 'neutralino.js 위치 변경(./neutralino.js)에 맞춰 설정 파일의 clientLibrary 경로를 "/neutralino.js"로 업데이트해야 버튼이 작동합니다.'
            : '프로그램 기본 환경 설정 파일',
          status: isClMismatch
            ? '설정 경로 업데이트 필요 ("/js/neutralino.js" → "/neutralino.js")'
            : cfgCheck.corruptedContent
            ? `설정 파일 손상 (${cfgCheck.reason || 'JSON 오류'})`
            : cfgCheck.corruptedZeroByte
            ? '파일 손상 (0바이트)'
            : '파일 없음',
          category: isClMismatch ? 'config_client_library' : 'core',
        });
      }

      if (!neuRootCheck.exists) {
        if (neuLegacySubfolderCheck.exists) {
          missingFiles.push({
            fileName: 'neutralino.js',
            expectedPath: './neutralino.js (실행 파일 .exe와 같은 폴더)',
            role: '실행기 내부 시스템 연결 라이브러리 (js/ 폴더에서 꺼내어 실행 파일 .exe와 같은 폴더에 넣어주세요)',
            status: '위치 이동 필요 (js/neutralino.js → ./neutralino.js)',
            category: 'relocate_neutralino_js',
          });
        } else {
          missingFiles.push({
            fileName: 'neutralino.js',
            expectedPath: './neutralino.js (실행 파일 .exe와 같은 폴더)',
            role: '실행기 내부 시스템 연결 라이브러리 (실행 파일 .exe와 같은 폴더에 위치해야 함)',
            status: neuRootCheck.corruptedZeroByte ? '파일 손상 (0바이트)' : '파일 없음',
            category: 'core',
          });
        }
      }

      if (!launcherCheck.exists) {
        missingFiles.push({
          fileName: 'launcher.html',
          expectedPath: './launcher.html',
          role: '게임 실행 및 세이브 관리 런처 화면 파일',
          status: launcherCheck.corruptedZeroByte ? '파일 손상 (0바이트)' : '파일 없음',
          category: 'core',
        });
      }

      if (!bridgeCheck.exists) {
        missingFiles.push({
          fileName: 'neutralino-storage-bridge.js',
          expectedPath: './neutralino-storage-bridge.js',
          role: '세이브 · 모드 고속 자동 저장 엔진 파일',
          status: bridgeCheck.corruptedZeroByte
            ? '파일 손상 (0바이트)'
            : bridgeCheck.corruptedContent
            ? '파일 내용 손상'
            : '파일 없음',
          category: 'core',
        });
      }

      if (!extractorCheck.exists) {
        missingFiles.push({
          fileName: extName,
          expectedPath: `./${extName}`,
          role: '기존 인터넷 창 세이브 백업 추출 도구 파일',
          status: extractorCheck.corruptedZeroByte ? '파일 손상 (0바이트)' : '파일 없음',
          category: 'core',
        });
      }



      // 10. userdata 폴더 내 세이브 데이터 무결성 검사 (불완전한 userdata 감지)
      const canUseFs =
        Boolean(this.config.customFs) ||
        Boolean(
          global.Neutralino &&
            global.Neutralino.filesystem &&
            (global.NL_TOKEN || global.NL_CONNECT_TOKEN) &&
            !this._fsRpcTimedOut
        );

      if (canUseFs) {
        let hasSqliteMain = false;
        let sqliteMainSize = 0;
        let hasSqliteWal = false;
        let hasSqliteShm = false;

        try {
          const stMain = await this.fs.getStats(this.sqliteDbPath);
          if (stMain && stMain.isFile) {
            hasSqliteMain = true;
            sqliteMainSize = Number(stMain.size || 0);
          }
        } catch (_) {}

        try {
          const stWal = await this.fs.getStats(`${this.sqliteDbPath}-wal`);
          if (stWal && stWal.isFile) hasSqliteWal = true;
        } catch (_) {}

        try {
          const stShm = await this.fs.getStats(`${this.sqliteDbPath}-shm`);
          if (stShm && stShm.isFile) hasSqliteShm = true;
        } catch (_) {}

        if (!hasSqliteMain && (hasSqliteWal || hasSqliteShm)) {
          missingFiles.push({
            fileName: 'userdata/storage.sqlite',
            expectedPath: './userdata/storage.sqlite',
            role: '세이브 데이터베이스 본체 파일 (임시 파일 -wal/-shm만 남아 있고 본체 파일이 누락됨)',
            status: '본체 파일 누락 (불완전한 userdata)',
            category: 'userdata',
          });
        } else if (hasSqliteMain && sqliteMainSize === 0) {
          missingFiles.push({
            fileName: 'userdata/storage.sqlite',
            expectedPath: './userdata/storage.sqlite',
            role: '세이브 데이터베이스 본체 파일 (0바이트 빈 파일 상태)',
            status: '불완전한 파일 (0바이트)',
            category: 'userdata',
          });
        }

        // userdata/launcher-config.json 무결성 검사 (존재할 경우)
        try {
          const stCfg = await this.fs.getStats(this.launcherConfigPath);
          if (stCfg && stCfg.isFile) {
            if (Number(stCfg.size || 0) === 0) {
              missingFiles.push({
                fileName: 'userdata/launcher-config.json',
                expectedPath: './userdata/launcher-config.json',
                role: '런처 설정 보관 파일 (0바이트 빈 파일 상태)',
                status: '불완전한 파일 (0바이트)',
                category: 'userdata',
              });
            } else {
              const rawLauncherCfg = await this.fs.readFile(this.launcherConfigPath);
              try {
                const parsedLCfg = JSON.parse(rawLauncherCfg);
                if (!parsedLCfg || typeof parsedLCfg !== 'object') {
                  throw new Error('Invalid object');
                }
              } catch (_) {
                missingFiles.push({
                  fileName: 'userdata/launcher-config.json',
                  expectedPath: './userdata/launcher-config.json',
                  role: '런처 설정 보관 파일 (내용 손상)',
                  status: '파일 손상 (JSON 오류)',
                  category: 'userdata',
                });
              }
            }
          }
        } catch (_) {}

        // userdata/storage.json 구버전 파일이 있을 때 연결된 외부 .dat 파일 누락 검사
        try {
          const stLegacy = await this.fs.getStats(this.legacyMainFilePath);
          if (stLegacy && stLegacy.isFile) {
            const rawLegacy = await this.fs.readFile(this.legacyMainFilePath);
            let parsedLegacy = null;
            try {
              parsedLegacy = JSON.parse(rawLegacy);
            } catch (_) {
              missingFiles.push({
                fileName: 'userdata/storage.json',
                expectedPath: './userdata/storage.json',
                role: '세이브 데이터 파일 (내용 손상)',
                status: '파일 손상 (JSON 오류)',
                category: 'userdata',
              });
            }
            if (parsedLegacy && parsedLegacy.__external__ && typeof parsedLegacy.__external__ === 'object') {
              for (const [k, datFile] of Object.entries(parsedLegacy.__external__)) {
                const datPath = joinPath(this.storageDir, datFile);
                let datExists = false;
                try {
                  const stDat = await this.fs.getStats(datPath);
                  if (stDat && stDat.isFile && Number(stDat.size || 0) > 0) {
                    datExists = true;
                  }
                } catch (_) {}
                if (!datExists) {
                  missingFiles.push({
                    fileName: `userdata/${datFile}`,
                    expectedPath: `./userdata/${datFile}`,
                    role: `'${k}' 대용량 세이브 데이터 파일 (storage.json에 등록되어 있으나 실제 파일이 없음)`,
                    status: '세이브 파일 누락 (불완전한 userdata)',
                    category: 'userdata',
                  });
                }
              }
            }
          }
        } catch (_) {}
      }

      return {
        ok: missingFiles.length === 0,
        missingFiles,
      };
    }

    async repairMissingExtensionAndRelocatedFiles() {
      try {
        await this.autoEnsureExtensionsAndUserdataFolders();
      } catch (_) {}

      // js/neutralino.js에 파일이 있고 ./neutralino.js에 없는 경우 루트로 복사 및 설정 갱신
      try {
        const legacyPathCandidates = [
          joinPath(appRoot, 'js', 'neutralino.js'),
          'js/neutralino.js',
          './js/neutralino.js',
        ];
        for (const lp of legacyPathCandidates) {
          try {
            const code = await this.fs.readFile(lp);
            if (code && (code.includes('Neutralino') || code.includes('NL_'))) {
              const targetRoot =
                appRoot && appRoot !== '.' ? joinPath(appRoot, 'neutralino.js') : './neutralino.js';
              await this.fs.writeFile(targetRoot, code);
              break;
            }
          } catch (_) {}
        }
      } catch (_) {}

      await this.patchNeutralinoConfigForExtensionAndSafeClose();
    }

    async repairIncompleteUserdataFiles() {
      const basePath = this.config.storageDir || joinPath(global.NL_PATH || '.', 'userdata');
      this.storageDir = basePath;
      this.sqliteDbPath = joinPath(this.storageDir, this.config.sqliteDbFileName);
      this.sqliteEndpointPath = joinPath(this.storageDir, this.config.sqliteEndpointFileName);
      this.legacyMainFilePath = joinPath(this.storageDir, this.config.legacyMainFileName);
      this.launcherConfigPath = joinPath(this.storageDir, this.config.launcherConfigFileName);

      await this.shutdownSqliteExtension();

      const toRemove = [
        this.sqliteDbPath,
        `${this.sqliteDbPath}-wal`,
        `${this.sqliteDbPath}-shm`,
        this.sqliteEndpointPath,
      ];
      for (const p of toRemove) {
        try {
          await this.fs.remove(p);
        } catch (_) {}
      }

      try {
        const rawLCfg = await this.fs.readFile(this.launcherConfigPath);
        JSON.parse(rawLCfg);
      } catch (_) {
        try {
          await this.fs.remove(this.launcherConfigPath);
        } catch (_) {}
      }
    }

    showMissingFilesBlocker(missingFiles = [], callbacks = {}) {
      if (typeof document === 'undefined') return;

      // 1. 기존 로딩 백드랍 즉시 제거
      this.hideSavingBackdrop(0);

      // 2. 런처 메인 컨테이너 진입 완전 차단 (숨김 및 비활성화)
      const mainContainer = document.getElementById('launcher-main-container');
      if (mainContainer) {
        mainContainer.style.setProperty('display', 'none', 'important');
        mainContainer.setAttribute('aria-hidden', 'true');
      }

      let blocker = document.getElementById('__neu-missing-files-blocker');
      if (blocker) blocker.remove();

      const hasUserdataIssues = missingFiles.some((f) => f.category === 'userdata');
      const hasConfigLibraryIssue = missingFiles.some((f) => f.category === 'config_client_library');
      const hasExtensionOrRelocateIssues = missingFiles.some(
        (f) => f.category === 'extensions' || f.category === 'relocate_neutralino_js' || f.category === 'config_client_library'
      );

      blocker = document.createElement('div');
      blocker.id = '__neu-missing-files-blocker';
      blocker.setAttribute('role', 'alertdialog');
      blocker.setAttribute('aria-modal', 'true');
      blocker.style.cssText = [
        'position:fixed',
        'inset:0',
        'width:100vw',
        'height:100vh',
        'z-index:2147483647',
        'background:radial-gradient(circle at top, #1e1b2e 0%, #090d16 70%)',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'padding:20px',
        'box-sizing:border-box',
        'font-family:"Inter",-apple-system,BlinkMacSystemFont,"Malgun Gothic","맑은 고딕",sans-serif',
        'color:#f8fafc',
        'overflow-y:auto',
      ].join(';');

      const itemsHtml = missingFiles
        .map((item) => {
          const isUserdata = item.category === 'userdata';
          const isExtension =
            item.category === 'extensions' || item.category === 'relocate_neutralino_js';
          const badgeBg = isUserdata
            ? 'rgba(245,158,11,0.18)'
            : isExtension
            ? 'rgba(99,102,241,0.2)'
            : 'rgba(244,63,94,0.2)';
          const badgeBorder = isUserdata
            ? 'rgba(251,191,36,0.45)'
            : isExtension
            ? 'rgba(129,140,248,0.45)'
            : 'rgba(251,113,133,0.45)';
          const badgeColor = isUserdata ? '#fcd34d' : isExtension ? '#c7d2fe' : '#fda4af';
          return `
            <div style="background:rgba(15,23,42,0.9);border:1px solid ${badgeBorder};border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:6px;text-align:left;">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
                <span style="font-family:monospace;font-size:14px;font-weight:700;color:#ffffff;word-break:break-all;">❌ ${item.fileName}</span>
                <span style="font-size:11px;font-weight:700;padding:3px 9px;border-radius:9999px;background:${badgeBg};color:${badgeColor};border:1px solid ${badgeBorder};">${item.status || '파일 없음'}</span>
              </div>
              <div style="font-size:12.5px;color:#cbd5e1;line-height:1.45;">${item.role || ''}</div>
              <div style="font-size:11.5px;color:#94a3b8;font-family:monospace;">필요 위치: ${item.expectedPath || item.fileName}</div>
            </div>
          `;
        })
        .join('');

      blocker.innerHTML = `
        <div style="background:linear-gradient(145deg,#0f172a 0%,#1e293b 100%);border:1.5px solid rgba(244,63,94,0.55);border-radius:24px;padding:32px 34px;max-width:640px;width:100%;box-shadow:0 25px 70px rgba(0,0,0,0.85),0 0 40px rgba(225,29,72,0.2);display:flex;flex-direction:column;gap:18px;text-align:center;">
          <div style="display:flex;flex-direction:column;align-items:center;gap:10px;">
            <span style="font-size:11px;font-weight:700;padding:4px 12px;border-radius:9999px;background:rgba(244,63,94,0.18);color:#fda4af;border:1px solid rgba(244,63,94,0.4);">
              ⚠️ 실행 중단 · 런처 화면 진입 차단됨
            </span>
            <div style="width:56px;height:56px;border-radius:9999px;background:rgba(244,63,94,0.16);border:2px solid rgba(251,113,133,0.6);display:flex;align-items:center;justify-content:center;font-size:26px;">
              🚫
            </div>
            <h1 style="margin:0;font-size:20px;font-weight:800;color:#ffffff;letter-spacing:-0.01em;">
              실행에 필요한 파일이 없거나 불완전합니다
            </h1>
            <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.55;max-width:520px;">
              안전한 세이브 보호와 정상 작동을 위해 아래 누락된 파일이 모두 확인되기 전에는 런처 화면으로 진입할 수 없습니다. 아래 목록을 확인한 뒤 파일을 복구해 주세요.
            </p>
          </div>

          <div id="__neu-missing-files-list" style="display:flex;flex-direction:column;gap:10px;max-height:290px;overflow-y:auto;padding-right:4px;">
            ${itemsHtml}
          </div>

          <div style="background:rgba(30,41,59,0.65);border:1px solid rgba(71,85,105,0.5);border-radius:12px;padding:11px 14px;font-size:12px;color:#cbd5e1;text-align:left;line-height:1.5;">
            💡 <b>해결 방법</b>: 위에 표시된 누락 파일을 필요 위치에 넣은 뒤 <b>[🔄 파일 다시 확인하기]</b> 버튼을 눌러주세요. (<code>neutralino.js</code>는 <code>js/</code> 폴더가 아닌 <code>.exe</code> 실행 파일과 같은 폴더에 있어야 합니다.)
          </div>

          <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:10px;padding-top:4px;">
            <button id="__neu-btn-retry-check" type="button" style="flex:1;min-width:165px;padding:13px 16px;border-radius:13px;border:none;background:#2563eb;color:#ffffff;font-size:13.5px;font-weight:700;cursor:pointer;box-shadow:0 8px 20px rgba(37,99,235,0.35);">
              🔄 파일 다시 확인하기
            </button>
            ${
              hasConfigLibraryIssue
                ? `<button id="__neu-btn-download-fixed-config" type="button" style="flex:1;min-width:210px;padding:13px 16px;border-radius:13px;border:1px solid rgba(16,185,129,0.55);background:rgba(5,150,105,0.35);color:#a7f3d0;font-size:13px;font-weight:700;cursor:pointer;">
                    💾 수정된 neutralino.config.json 다운로드 (폴더에 덮어쓰기)
                  </button>`
                : ''
            }
            ${
              hasExtensionOrRelocateIssues
                ? `<button id="__neu-btn-repair-extensions" type="button" style="flex:1;min-width:190px;padding:13px 16px;border-radius:13px;border:1px solid rgba(129,140,248,0.5);background:rgba(67,56,202,0.35);color:#e0e7ff;font-size:13px;font-weight:700;cursor:pointer;">
                    🛠️ extensions 파일 · neutralino.js 위치 자동 복구
                  </button>`
                : ''
            }
            ${
              hasUserdataIssues
                ? `<button id="__neu-btn-repair-userdata" type="button" style="flex:1;min-width:190px;padding:13px 16px;border-radius:13px;border:1px solid rgba(251,191,36,0.5);background:rgba(180,83,9,0.35);color:#fde68a;font-size:13px;font-weight:700;cursor:pointer;">
                    🛠️ 불완전한 세이브 폴더 초기화 후 시작
                  </button>`
                : ''
            }
            <button id="__neu-btn-exit-missing" type="button" style="padding:13px 16px;border-radius:13px;border:1px solid rgba(244,63,94,0.45);background:rgba(136,19,55,0.45);color:#fecdd3;font-size:13.5px;font-weight:700;cursor:pointer;">
              🚪 프로그램 종료
            </button>
          </div>
        </div>
      `;

      (document.body || document.documentElement).appendChild(blocker);

      const retryBtn = document.getElementById('__neu-btn-retry-check');
      if (retryBtn) {
        retryBtn.onclick = async () => {
          retryBtn.disabled = true;
          retryBtn.textContent = '⏳ 파일 확인 중...';
          if (typeof callbacks.onRetry === 'function') {
            await callbacks.onRetry();
          } else {
            window.location.reload();
          }
        };
      }

      const dlCfgBtn = document.getElementById('__neu-btn-download-fixed-config');
      if (dlCfgBtn) {
        dlCfgBtn.onclick = () => {
          const baseCfg =
            this._lastCheckedNeutralinoConfigObj && typeof this._lastCheckedNeutralinoConfigObj === 'object'
              ? JSON.parse(JSON.stringify(this._lastCheckedNeutralinoConfigObj))
              : {
                  applicationId: 'js.neutralino.waywardtavern',
                  version: '1.0.0',
                  defaultMode: 'window',
                  documentRoot: '/',
                  url: '/launcher.html',
                  enableServer: true,
                  enableNativeAPI: true,
                  exportAuthInfo: true,
                  tokenSecurity: 'none',
                  nativeAllowList: ['app.*', 'os.*', 'filesystem.*', 'window.*', 'events.*', 'extensions.*', 'storage.*'],
                  modes: {
                    window: {
                      title: 'Wayward Tavern',
                      width: 1280,
                      height: 860,
                      exitProcessOnClose: false,
                    },
                  },
                  cli: {
                    binaryName: 'wayward-tavern',
                    clientLibrary: '/neutralino.js',
                  },
                };
          baseCfg.exportAuthInfo = true;
          baseCfg.tokenSecurity = 'none';
          if (!baseCfg.cli || typeof baseCfg.cli !== 'object') baseCfg.cli = {};
          baseCfg.cli.clientLibrary = '/neutralino.js';
          if (!baseCfg.modes || typeof baseCfg.modes !== 'object') baseCfg.modes = {};
          if (!baseCfg.modes.window || typeof baseCfg.modes.window !== 'object') baseCfg.modes.window = {};
          baseCfg.modes.window.exitProcessOnClose = false;

          const blob = new Blob([JSON.stringify(baseCfg, null, 2)], { type: 'application/json;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'neutralino.config.json';
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        };
      }

      const repairExtBtn = document.getElementById('__neu-btn-repair-extensions');
      if (repairExtBtn) {
        repairExtBtn.onclick = async () => {
          repairExtBtn.disabled = true;
          repairExtBtn.textContent = '⏳ 파일 복구 중...';
          try {
            await this.repairMissingExtensionAndRelocatedFiles();
          } catch (_) {}
          if (typeof callbacks.onRetry === 'function') {
            await callbacks.onRetry();
          } else {
            window.location.reload();
          }
        };
      }

      const repairBtn = document.getElementById('__neu-btn-repair-userdata');
      if (repairBtn) {
        repairBtn.onclick = async () => {
          repairBtn.disabled = true;
          repairBtn.textContent = '⏳ 초기화 중...';
          try {
            await this.repairIncompleteUserdataFiles();
          } catch (_) {}
          if (typeof callbacks.onRetry === 'function') {
            await callbacks.onRetry();
          } else {
            window.location.reload();
          }
        };
      }

      const exitBtn = document.getElementById('__neu-btn-exit-missing');
      if (exitBtn) {
        exitBtn.onclick = async () => {
          exitBtn.disabled = true;
          exitBtn.textContent = '종료 중...';
          await this.shutdownSqliteExtension(true, true);
          if (global.Neutralino && global.Neutralino.app && typeof global.Neutralino.app.exit === 'function') {
            try {
              await global.Neutralino.app.exit(0);
            } catch (_) {}
          }
          try {
            window.close();
          } catch (_) {}
        };
      }
    }

    getEnvironmentDiagnostics() {
      ensureNeutralinoEnvironment();
      this.initDexieDatabase();
      const cfg = global.__NEU_DETECTED_CONFIG__ || null;
      return {
        version: BRIDGE_VERSION,
        isConnected: this.isNeutralinoConnected(),
        isLocalServer: isLocalNeutralinoUrl(),
        port: global.NL_PORT || (isLocalNeutralinoUrl() ? Number(window.location.port) : null),
        hasToken: Boolean(global.NL_TOKEN),
        os: global.NL_OS || inferOsFromNavigator(),
        dexieLoaded: Boolean(this.dexieDb),
        isExternalDexieLoaded: Boolean(this.isExternalDexieLoaded),
        sqliteConnected: Boolean(this.sqliteConnected),
        sqliteBackendName: this.sqliteBackendName || '대기 중',
        lastSaveError: this.lastSaveError || null,
        saveVerified: Boolean(this._verifiedSqliteCommit && !this.lastSaveError),
        unsavedChanges: this.hasUnsavedChanges(),
        detectedConfig: cfg,
      };
    }

    getLauncherConfig() {
      return { ...this.launcherConfig };
    }

    async saveLauncherConfig(partial = {}) {
      this.launcherConfig = {
        ...this.launcherConfig,
        ...partial,
        updatedAt: new Date().toISOString(),
      };
      if (!this.isNeutralinoConnected() || this.customSqliteStore) {
        return this.getLauncherConfig();
      }
      const payload = JSON.stringify(this.launcherConfig, null, 2);
      await this.enqueueFileOp(this.launcherConfigPath, () =>
        this.fs.writeFile(this.launcherConfigPath, payload)
      );
      return this.getLauncherConfig();
    }

    async openExtractorInExternalBrowser(customFileName) {
      ensureNeutralinoEnvironment();

      const fileName =
        customFileName || this.config.extractorFileName || 'localstorage-extractor.html';
      const appRoot = getAppRootDir();
      const fullExtractorPath = joinPath(appRoot, fileName);
      const resExtractorPath = joinPath(appRoot, 'resources', fileName);
      const osName = (global.NL_OS || inferOsFromNavigator()).toLowerCase();
      const isWin = osName.includes('win');
      const isMac = osName.includes('darwin') || osName.includes('mac');

      const port = global.NL_PORT || (isLocalNeutralinoUrl() ? Number(window.location.port) : 0);
      const httpUrl =
        typeof window !== 'undefined' &&
        window.location &&
        window.location.protocol.startsWith('http')
          ? new URL('/' + fileName.replace(/^\/+/, ''), window.location.origin).href
          : port
          ? `http://127.0.0.1:${port}/${fileName}`
          : '';

      if (
        global.Neutralino &&
        global.Neutralino.os &&
        typeof global.Neutralino.os.execCommand === 'function'
      ) {
        try {
          if (isWin) {
            const winPath = fullExtractorPath.replace(/\//g, '\\');
            const winResPath = resExtractorPath.replace(/\//g, '\\');
            const cmdStr =
              appRoot && appRoot !== '.'
                ? `cmd /c if exist "${winPath}" (start "" "${winPath}") else if exist "${winResPath}" (start "" "${winResPath}") else (start "" "${httpUrl || winPath}")`
                : `cmd /c if exist "${fileName}" (start "" "${fileName}") else if exist "resources\\${fileName}" (start "" "resources\\${fileName}") else (start "" "${httpUrl || fileName}")`;
            await global.Neutralino.os.execCommand(cmdStr, { background: true });
            return {
              opened: true,
              target: appRoot && appRoot !== '.' ? winPath : fileName,
              mode: 'external-os-exec',
            };
          } else if (isMac) {
            const safePath = fullExtractorPath.replace(/"/g, '\\"');
            const safeRes = resExtractorPath.replace(/"/g, '\\"');
            const cmdStr = `sh -c 'if [ -f "${safePath}" ]; then open "${safePath}"; elif [ -f "${safeRes}" ]; then open "${safeRes}"; else open "${httpUrl || safePath}"; fi'`;
            await global.Neutralino.os.execCommand(cmdStr, { background: true });
            return { opened: true, target: fullExtractorPath, mode: 'external-os-exec' };
          } else {
            const safePath = fullExtractorPath.replace(/"/g, '\\"');
            const safeRes = resExtractorPath.replace(/"/g, '\\"');
            const cmdStr = `sh -c 'if [ -f "${safePath}" ]; then xdg-open "${safePath}"; elif [ -f "${safeRes}" ]; then xdg-open "${safeRes}"; else xdg-open "${httpUrl || safePath}"; fi'`;
            await global.Neutralino.os.execCommand(cmdStr, { background: true });
            return { opened: true, target: fullExtractorPath, mode: 'external-os-exec' };
          }
        } catch (_) {}
      }

      if (
        global.Neutralino &&
        global.Neutralino.os &&
        typeof global.Neutralino.os.open === 'function' &&
        httpUrl
      ) {
        try {
          await global.Neutralino.os.open(httpUrl);
          return { opened: true, target: httpUrl, mode: 'neutralino-os-open' };
        } catch (_) {}
      }

      if (typeof window !== 'undefined' && typeof window.open === 'function') {
        const targetUrl = httpUrl || `./${fileName}`;
        const win = window.open(targetUrl, '_blank');
        if (win) {
          return { opened: true, target: targetUrl, mode: 'window-open-fallback' };
        }
      }

      throw new Error(
        '외부 인터넷 창을 열지 못했습니다. 실행 폴더에 localstorage-extractor.html 파일이 있는지 확인해 주세요.'
      );
    }

    async prepareBridgedGameHtml(rawSelectedPath) {
      const targetPath = stripBridgedPrefix(
        rawSelectedPath || this.launcherConfig.gameHtmlPath || ''
      );
      if (!targetPath) {
        throw new Error('먼저 게임 실행 파일(.html)을 선택해 주세요.');
      }

      const appRoot = getAppRootDir();
      const fullHtmlPath = normalizeSlashes(targetPath);
      const htmlDir = dirname(fullHtmlPath);
      const cleanFileName = basename(fullHtmlPath);
      const bridgedFileName = `__neu_bridged_${cleanFileName}`;
      const bridgedFullPath = joinPath(htmlDir, bridgedFileName);

      const isWin = (global.NL_OS || inferOsFromNavigator()).toLowerCase().includes('win');
      const rootCmp = isWin ? appRoot.toLowerCase() : appRoot;
      const htmlCmp = isWin ? fullHtmlPath.toLowerCase() : fullHtmlPath;
      const isInternal = Boolean(rootCmp && rootCmp !== '.' && htmlCmp.startsWith(rootCmp + '/'));

      const mountFolder = this.config.mountFolderName || 'game_mount';
      const mountFullPath = joinPath(appRoot, mountFolder);

      if (!isInternal) {
        if (
          global.Neutralino &&
          global.Neutralino.os &&
          typeof global.Neutralino.os.execCommand === 'function'
        ) {
          if (isWin) {
            const winMount = mountFullPath.replace(/\//g, '\\').replace(/\\+$/, '');
            const winTarget = htmlDir.replace(/\//g, '\\').replace(/\\+$/, '');
            await global.Neutralino.os.execCommand(
              `cmd /c if exist "${winMount}" rmdir "${winMount}"`
            );
            const res = await global.Neutralino.os.execCommand(
              `cmd /c mklink /J "${winMount}" "${winTarget}"`
            );
            if (res && res.exitCode !== 0 && res.stdErr) {
              throw new Error(`게임 폴더 연결에 실패했습니다: ${res.stdErr}`);
            }
          } else {
            const safeMount = mountFullPath.replace(/\/+$/, '').replace(/"/g, '\\"');
            const safeTarget = htmlDir.replace(/\/+$/, '').replace(/"/g, '\\"');
            const res = await global.Neutralino.os.execCommand(
              `rm -f "${safeMount}" && ln -sfn "${safeTarget}" "${safeMount}"`
            );
            if (res && res.exitCode !== 0 && res.stdErr) {
              throw new Error(`게임 폴더 연결에 실패했습니다: ${res.stdErr}`);
            }
          }
        }
      }

      let sourceSize = 0;
      let bridgedExists = false;
      if (!this.config.customFs) {
        try {
          const stSrc = await this.fs.getStats(fullHtmlPath);
          if (stSrc && stSrc.isFile) sourceSize = Number(stSrc.size || 0);
        } catch (_) {}
        try {
          const stBr = await this.fs.getStats(bridgedFullPath);
          if (stBr && stBr.isFile && Number(stBr.size || 0) > sourceSize) {
            bridgedExists = true;
          }
        } catch (_) {}
      }

      let finalTargetFileName = cleanFileName;
      const isAlreadyUpToDate =
        bridgedExists &&
        sourceSize > 0 &&
        this.launcherConfig &&
        this.launcherConfig.gameHtmlPath === fullHtmlPath &&
        this.launcherConfig.bridgedVersion === BRIDGE_VERSION &&
        this.launcherConfig.sourceHtmlSize === sourceSize &&
        global.NL_TOKEN;

      if (isAlreadyUpToDate) {
        finalTargetFileName = bridgedFileName;
      } else {
        let originalHtmlContent = null;
        try {
          originalHtmlContent = await this.fs.readFile(fullHtmlPath);
        } catch (_) {
          const fallbackUrl = isInternal
            ? '/' + fullHtmlPath.slice(appRoot.length).replace(/^\/+/, '')
            : `/${mountFolder}/${encodeURIComponent(cleanFileName).replace(/%2F/g, '/')}`;
          originalHtmlContent = syncHttpGetText(fallbackUrl, false);
        }

        if (originalHtmlContent && typeof originalHtmlContent === 'string') {
          const stripRegex = new RegExp(
            '\\x3c!-- __NEU_STORAGE_BRIDGE_INJECTED_START__ --\\x3e[\\s\\S]*?\\x3c!-- __NEU_STORAGE_BRIDGE_INJECTED_END__ --\\x3e\\s*',
            'g'
          );
          const strippedHtml = this.rewriteGameAutosaveBootstrap(originalHtmlContent.replace(stripRegex, ''));

          const selfSource = `(${initNeutralinoStorageBridgeV9.toString()})(typeof window !== "undefined" ? window : globalThis);`;
          const safeInlineBridgeSource = selfSource.replace(
            new RegExp('\\x3c/script', 'gi'),
            '\\x3c\\/script'
          );

          // 주의: NL_TOKEN 및 NL_CONNECT_TOKEN은 매 실행마다 새로 발급되므로 디스크의 __neu_bridged_ HTML에 하드코딩하지 않고,
          // 런타임에 /__neutralino_globals.js 및 sessionStorage에서 동적으로 읽도록 하여 구버전 토큰으로 인한 WebSocket 400 오류를 원천 차단합니다.
          const envBootstrapJson = JSON.stringify({
            NL_PORT: global.NL_PORT || (isLocalNeutralinoUrl() ? Number(window.location.port) : null),
            NL_OS: global.NL_OS || inferOsFromNavigator(),
            NL_CWD: global.NL_CWD || '',
            NL_PATH: global.NL_PATH || '.',
            NL_PID: global.NL_PID || null,
          }).replace(new RegExp('\\x3c/script', 'gi'), '\\x3c\\/script');

          const injectionBlock = [
            '\x3c!-- __NEU_STORAGE_BRIDGE_INJECTED_START__ --\x3e',
            '\x3cscript src="/__neutralino_globals.js" onerror=""\x3e\x3c/script\x3e',
            '\x3cscript\x3e(function(){try{if(typeof NL_TOKEN!=="undefined"&&NL_TOKEN){window.__early_NL_TOKEN=NL_TOKEN;}if(typeof NL_CONNECT_TOKEN!=="undefined"&&NL_CONNECT_TOKEN){window.__early_NL_CONNECT_TOKEN=NL_CONNECT_TOKEN;}if(typeof NL_PORT!=="undefined"&&NL_PORT){window.__early_NL_PORT=NL_PORT;}if(typeof NL_PID!=="undefined"&&NL_PID){window.__early_NL_PID=NL_PID;}}catch(e){}})();\x3c/script\x3e',
            '\x3cscript src="/neutralino.js" onerror=""\x3e\x3c/script\x3e',
            '\x3cscript\x3e(function(){try{if(typeof NL_TOKEN!=="undefined"&&NL_TOKEN){window.__early_NL_TOKEN=NL_TOKEN;}else if(window.__early_NL_TOKEN){window.NL_TOKEN=window.__early_NL_TOKEN;}}catch(e){}})();\x3c/script\x3e',
            '\x3cscript src="/dexie.js" onerror=""\x3e\x3c/script\x3e',
            '\x3cscript\x3e',
            '(function(){',
            `  var env = ${envBootstrapJson};`,
            '  for (var k in env) { if (env[k] !== null && env[k] !== "" && !window[k]) { window[k] = env[k]; if (k === "NL_PID") window.__early_NL_PID = env[k]; } }',
            '})();',
            safeInlineBridgeSource,
            '\x3c/script\x3e',
            `\x3cscript src="/neutralino-storage-bridge.js?v=${BRIDGE_VERSION}" onerror=""\x3e\x3c/script\x3e`,
            '\x3c!-- __NEU_STORAGE_BRIDGE_INJECTED_END__ --\x3e',
          ].join('\n');

          const headRegex = new RegExp('(\\x3chead[^\\x3e]*\\x3e)', 'i');
          const htmlRegex = new RegExp('(\\x3chtml[^\\x3e]*\\x3e)', 'i');

          let bridgedHtml;
          if (headRegex.test(strippedHtml)) {
            bridgedHtml = strippedHtml.replace(headRegex, (m) => `${m}\n${injectionBlock}\n`);
          } else if (htmlRegex.test(strippedHtml)) {
            bridgedHtml = strippedHtml.replace(
              htmlRegex,
              (m) => `${m}\n\x3chead\x3e\n${injectionBlock}\n\x3c/head\x3e\n`
            );
          } else {
            bridgedHtml = `${injectionBlock}\n${strippedHtml}`;
          }

          try {
            await this.fs.writeFile(bridgedFullPath, bridgedHtml);
            finalTargetFileName = bridgedFileName;
          } catch (_) {}
        }
      }

      let mountedUrl;
      if (isInternal) {
        const relDir = dirname(fullHtmlPath.slice(appRoot.length));
        const joinedRel =
          relDir === '.' || relDir === '/'
            ? `/${finalTargetFileName}`
            : `${relDir.startsWith('/') ? relDir : '/' + relDir}/${finalTargetFileName}`;
        mountedUrl = joinedRel.replace(/\/+/g, '/');
      } else {
        mountedUrl = `/${mountFolder}/${encodeURIComponent(finalTargetFileName).replace(/%2F/g, '/')}`;
      }

      return await this.saveLauncherConfig({
        gameHtmlPath: fullHtmlPath,
        mountedUrl,
        isExternalMount: !isInternal,
        bridgedVersion: BRIDGE_VERSION,
        sourceHtmlSize: sourceSize,
      });
    }

    async configureGameHtmlPath(selectedHtmlPath) {
      if (!selectedHtmlPath) {
        throw new Error('선택된 게임 파일이 없습니다.');
      }
      return await this.prepareBridgedGameHtml(selectedHtmlPath);
    }

    async pickGameHtmlFile() {
      ensureNeutralinoEnvironment();
      if (
        global.Neutralino &&
        global.Neutralino.os &&
        typeof global.Neutralino.os.showOpenDialog === 'function'
      ) {
        const entries = await global.Neutralino.os.showOpenDialog('게임 실행 파일 선택', {
          filters: [
            { name: '게임 HTML 파일', extensions: ['html', 'htm'] },
            { name: '모든 파일', extensions: ['*'] },
          ],
          multiSelections: false,
        });

        const selected = Array.isArray(entries)
          ? entries[0]
          : entries && Array.isArray(entries.selectedEntries)
          ? entries.selectedEntries[0]
          : typeof entries === 'string'
          ? entries
          : null;
        if (!selected) {
          return { cancelled: true };
        }
        const shownAt = Date.now();
        this.showSavingBackdrop(
          '게임 실행 파일 연결 중...',
          `선택한 게임 파일(${basename(selected)})에 자동 세이브 보호 엔진을 연결하고 있습니다. 잠시만 기다려 주세요.`,
          { mode: 'loading', badgeText: '게임 파일 준비 중' }
        );
        await this.waitForBackdropPaint(70);
        try {
          const cfg = await this.configureGameHtmlPath(selected);
          const elapsed = Date.now() - shownAt;
          if (elapsed < 420) {
            await new Promise((r) => setTimeout(r, 420 - elapsed));
          }
          this.showSavingBackdrop(
            '게임 실행 파일 연결 완료!',
            `게임 파일(${basename(selected)})이 정상적으로 연결되었습니다.`,
            { mode: 'success', badgeText: '연결 완료 ✓' }
          );
          await this.waitForBackdropPaint(320);
          return { cancelled: false, config: cfg };
        } finally {
          this.hideSavingBackdrop(180);
        }
      }

      throw new Error('파일 선택 창을 열 수 없습니다. 프로그램을 다시 실행해 주세요.');
    }

    async launchConfiguredGame() {
      let cfg = this.getLauncherConfig();
      if (!cfg.gameHtmlPath && !cfg.mountedUrl) {
        throw new Error('먼저 게임 실행 파일(.html)을 선택해 주세요.');
      }

      if (typeof window !== 'undefined' && window.location && window.location.pathname) {
        if (window.location.pathname.includes('launcher')) {
          sessionSet('__NEU_LAUNCHER_PATH__', window.location.pathname);
        }
      }

      const shownAt = Date.now();
      this.showSavingBackdrop(
        '게임 데이터 불러오는 중...',
        '저장된 세이브와 모드 설정을 게임 화면에 연결하고 있습니다. 잠시만 기다려 주세요.',
        { mode: 'loading', badgeText: '게임 실행 준비 중' }
      );
      await this.waitForBackdropPaint(70);

      await this.flushAll({ checkpoint: true });

      if (cfg.gameHtmlPath && this.isNeutralinoConnected()) {
        try {
          this.showSavingBackdrop(
            '게임 실행 준비 중...',
            '게임 실행 파일과 세이브 보호 기능을 연결하고 있습니다...',
            { mode: 'loading', badgeText: '게임 실행 준비 중' }
          );
          cfg = await this.prepareBridgedGameHtml(cfg.gameHtmlPath);
        } catch (_) {}
      }

      this.saveSnapshotToWindowName();

      if (typeof window !== 'undefined') {
        window.location.href = cfg.mountedUrl;
      }
    }

    async goToLauncherSettings() {
      const startMs = Date.now();
      this.showSavingBackdrop(
        '세이브 데이터 저장 및 확인 중...',
        '현재까지의 진행 상황을 안전하게 저장하고 검증한 뒤 런처 화면으로 이동합니다.',
        { mode: 'loading', badgeText: '세이브 보호 작동 중' }
      );
      await this.waitForBackdropPaint(70);

      await this.flushAll({ checkpoint: true });

      const elapsed = Date.now() - startMs;
      if (elapsed < 550) {
        await new Promise((r) => setTimeout(r, 550 - elapsed));
      }

      this.showSavingBackdrop(
        '저장 확인 완료!',
        '런처 화면으로 이동합니다...',
        { mode: 'success', badgeText: '저장 검증 완료 ✓' }
      );
      await this.waitForBackdropPaint(220);

      this.saveSnapshotToWindowName();
      if (typeof window !== 'undefined') {
        const launcherPath = sessionGet('__NEU_LAUNCHER_PATH__') || '/launcher.html';
        window.location.href = `${launcherPath}?stay=1`;
      }
    }

    async pickAndImportBackupFile() {
      ensureNeutralinoEnvironment();
      let rawText = null;
      let selectedLabel = '';

      if (
        global.Neutralino &&
        global.Neutralino.os &&
        typeof global.Neutralino.os.showOpenDialog === 'function'
      ) {
        try {
          const entries = await global.Neutralino.os.showOpenDialog(
            '세이브 백업 파일 선택',
            {
              filters: [
                { name: '세이브 백업 파일', extensions: ['json', 'txt'] },
                { name: '모든 파일', extensions: ['*'] },
              ],
              multiSelections: false,
            }
          );

          const selected = Array.isArray(entries)
            ? entries[0]
            : entries && Array.isArray(entries.selectedEntries)
            ? entries.selectedEntries[0]
            : typeof entries === 'string'
            ? entries
            : null;
          if (selected) {
            selectedLabel = selected;
            this.showSavingBackdrop(
              '세이브 백업 파일 읽어오는 중...',
              `선택한 백업 파일(${basename(selected)})의 데이터를 읽고 있습니다. 잠시만 기다려 주세요.`,
              { mode: 'loading', badgeText: '백업 파일 읽는 중', progress: 20 }
            );
            await this.waitForBackdropPaint(70);
            rawText = await this.fs.readFile(selected);
          } else {
            return { cancelled: true };
          }
        } catch (_) {
          this.hideSavingBackdrop(120);
          rawText = null;
        }
      }

      if (rawText === null && typeof document !== 'undefined') {
        const picked = await new Promise((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.json,.txt,application/json,text/plain';
          input.style.display = 'none';

          input.onchange = async () => {
            const file = input.files && input.files[0];
            input.remove();
            if (!file) {
              resolve(null);
              return;
            }
            try {
              this.showSavingBackdrop(
                '세이브 백업 파일 읽어오는 중...',
                `선택한 백업 파일(${file.name})의 데이터를 읽고 있습니다. 잠시만 기다려 주세요.`,
                { mode: 'loading', badgeText: '백업 파일 읽는 중', progress: 20 }
              );
              await this.waitForBackdropPaint(70);
              const text = await file.text();
              resolve({ name: file.name, text });
            } catch (err) {
              this.hideSavingBackdrop(120);
              resolve({ error: err });
            }
          };

          input.oncancel = () => {
            input.remove();
            resolve(null);
          };

          document.body.appendChild(input);
          input.click();
        });

        if (!picked) {
          return { cancelled: true };
        }
        if (picked.error) {
          throw picked.error;
        }
        selectedLabel = picked.name;
        rawText = picked.text;
      }

      if (!rawText) {
        this.hideSavingBackdrop(120);
        return { cancelled: true };
      }

      return await this.importRawBackupText(rawText, selectedLabel);
    }

    async importRawBackupText(rawText, selectedLabel = 'backup.json') {
      const shownAt = Date.now();
      this.showSavingBackdrop(
        '세이브 백업 데이터 분석 중...',
        `백업 파일(${basename(selectedLabel)})의 데이터 형식을 확인하고 있습니다. 잠시만 기다려 주세요.`,
        { mode: 'loading', badgeText: '백업 데이터 검증 중', progress: 35 }
      );
      await this.waitForBackdropPaint(70);

      try {
        const cleanText = String(rawText).replace(/^\uFEFF/, '').trim();
        let parsed;
        try {
          parsed = JSON.parse(cleanText);
        } catch (_) {
          throw new Error('선택한 파일이 올바른 세이브 백업 파일 형식이 아닙니다.');
        }

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('올바른 세이브 백업 데이터가 아닙니다.');
        }

        const entryList = Object.entries(parsed);
        this.showSavingBackdrop(
          `세이브 백업 데이터 불러오는 중... (총 ${entryList.length}개 항목)`,
          '백업 파일의 세이브와 모드 설정을 저장소에 반영하고 있습니다. 잠시만 기다려 주세요.',
          { mode: 'loading', badgeText: '백업 복원 중', progress: 65 }
        );
        await this.waitForBackdropPaint(70);

        const processed = {};
        for (const [k, v] of entryList) {
          processed[k] = typeof v === 'string' ? v : JSON.stringify(v);
        }

        await this.importDump(processed, true);
        await this.saveLauncherConfig({
          lastBackupImportedAt: new Date().toISOString(),
        });
        this.saveSnapshotToWindowName();

        this.showSavingBackdrop(
          '백업 데이터 적용 완료!',
          `총 ${entryList.length}개의 세이브와 모드 설정이 안전하게 반영되었습니다.`,
          { mode: 'success', badgeText: '복원 완료 ✓' }
        );
        await this.waitForBackdropPaint(150);

        return {
          cancelled: false,
          fileName: selectedLabel,
          stats: this.getStats(),
        };
      } catch (err) {
        this.showSavingBackdrop(
          '백업 파일 불러오기 실패',
          err && err.message ? err.message : '백업 파일을 불러오는 중 오류가 발생했습니다.',
          { mode: 'error', badgeText: '불러오기 오류' }
        );
        await this.waitForBackdropPaint(750);
        throw err;
      } finally {
        this.hideSavingBackdrop(180);
      }
    }

    async exportBackupFileWithPicker() {
      await this.ensureDataLoaded();
      ensureNeutralinoEnvironment();
      const startMs = Date.now();

      const formatByteLabel = (chars) => {
        if (chars >= 1024 * 1024) {
          return (chars / (1024 * 1024)).toFixed(2) + ' MB';
        }
        if (chars >= 1024) {
          return (chars / 1024).toFixed(1) + ' KB';
        }
        return chars + ' B';
      };

      this.showSavingBackdrop(
        '세이브 백업 데이터 준비 중...',
        '현재 진행 상황과 모드 설정을 백업 파일로 내보낼 준비를 하고 있습니다. 잠시만 기다려 주세요.',
        { mode: 'loading', badgeText: '백업 데이터 준비 중', progress: 10 }
      );
      await this.waitForBackdropPaint(80);

      try {
        if (this.hasUnsavedChanges()) {
          try {
            await Promise.race([
              this.flushDexie(),
              new Promise((r) => setTimeout(r, 600)),
            ]);
          } catch (_) {}
        }

        const dumpObj = this.exportDump();
        const entries = Object.entries(dumpObj);

        if (entries.length === 0) {
          const emptyElapsed = Date.now() - startMs;
          if (emptyElapsed < 400) {
            await new Promise((r) => setTimeout(r, 400 - emptyElapsed));
          }
          this.showSavingBackdrop(
            '보관된 세이브 데이터가 없습니다',
            '아직 저장된 게임 진행 데이터나 모드 설정이 없어 내보낼 백업 항목이 없습니다.',
            { mode: 'warning', badgeText: '내보낼 데이터 없음' }
          );
          await this.waitForBackdropPaint(850);
          this.showActionToast('현재 보관 중인 세이브 데이터가 없습니다.', true);
          return { saved: false, empty: true };
        }

        this.showSavingBackdrop(
          `세이브 백업 데이터 추출 중... (총 ${entries.length}개 항목)`,
          '게임 진행 세이브와 모드 설정 데이터를 백업 파일 형식으로 변환하고 있습니다. 잠시만 기다려 주세요.',
          { mode: 'loading', badgeText: '백업 데이터 추출 중', progress: 18 }
        );
        await this.waitForBackdropPaint(60);

        const jsonParts = ['{\n'];
        let totalChars = 2;
        let lastYieldMs = Date.now();

        for (let i = 0; i < entries.length; i++) {
          const [k, v] = entries[i];
          const line = `  ${JSON.stringify(k)}: ${JSON.stringify(v)}${
            i < entries.length - 1 ? ',' : ''
          }\n`;
          jsonParts.push(line);
          totalChars += line.length;

          if (Date.now() - lastYieldMs > 30) {
            const pct = Math.min(48, 18 + Math.round(((i + 1) / entries.length) * 30));
            this.showSavingBackdrop(
              `세이브 백업 데이터 추출 중... (${pct}%)`,
              `총 ${entries.length}개 항목 중 ${i + 1}개 항목을 백업 데이터로 변환하고 있습니다...`,
              { mode: 'loading', badgeText: '백업 데이터 추출 중', progress: pct }
            );
            await this.waitForBackdropPaint(16);
            lastYieldMs = Date.now();
          }
        }
        jsonParts.push('}');
        totalChars += 1;

        const sizeLabel = formatByteLabel(totalChars);
        const defaultName = `wayward-save-backup-${new Date().toISOString().slice(0, 10)}.json`;

        const prepElapsed = Date.now() - startMs;
        if (prepElapsed < 380) {
          await new Promise((r) => setTimeout(r, 380 - prepElapsed));
        }

        const canUseNativeSaveDialog = Boolean(
          global.Neutralino &&
            global.Neutralino.os &&
            typeof global.Neutralino.os.showSaveDialog === 'function' &&
            (this.config.customFs || global.NL_TOKEN || global.NL_CONNECT_TOKEN || isLocalNeutralinoUrl())
        );

        if (canUseNativeSaveDialog) {
          let dialogSupported = true;
          let rawSavePath = '';
          try {
            this.showSavingBackdrop(
              '백업 파일 저장 위치 선택 대기 중...',
              `백업 데이터(${sizeLabel}, 총 ${entries.length}개 항목) 준비가 완료되었습니다. 열린 파일 저장 창에서 보관할 위치를 선택해 주세요.`,
              { mode: 'loading', badgeText: '저장 위치 선택 중', progress: 50 }
            );
            await this.waitForBackdropPaint(50);

            const saveDialogRes = await global.Neutralino.os.showSaveDialog(
              '세이브 백업 파일 저장 위치 선택',
              {
                defaultPath: defaultName,
                filters: [{ name: '세이브 백업 파일 (*.json)', extensions: ['json'] }],
              }
            );
            rawSavePath =
              typeof saveDialogRes === 'string'
                ? saveDialogRes
                : saveDialogRes && typeof saveDialogRes.selectedEntry === 'string'
                ? saveDialogRes.selectedEntry
                : saveDialogRes && typeof saveDialogRes.returnValue === 'string'
                ? saveDialogRes.returnValue
                : '';
          } catch (_) {
            dialogSupported = false;
          }

          if (dialogSupported) {
            let savePath = String(rawSavePath || '').trim();
            if (!savePath) {
              this.showSavingBackdrop(
                '백업 저장이 취소되었습니다',
                '파일 저장 위치를 선택하지 않아 세이브 백업 내보내기를 취소했습니다.',
                { mode: 'warning', badgeText: '백업 저장 취소됨' }
              );
              await this.waitForBackdropPaint(500);
              return { saved: false, cancelled: true };
            }

            if (!/\.[a-z0-9]+$/i.test(savePath)) {
              savePath += '.json';
            }

            const fileNameOnly = basename(savePath);
            const writeStartMs = Date.now();
            this.showSavingBackdrop(
              '세이브 백업 데이터를 내보내는 중... (55%)',
              `선택한 위치에 세이브 백업 파일(${fileNameOnly} · ${sizeLabel})을 기록하고 있습니다. 잠시만 기다려 주세요.`,
              { mode: 'loading', badgeText: '백업 데이터 내보내는 중', progress: 55 }
            );
            await this.waitForBackdropPaint(70);

            const CHUNK_LIMIT = 1536 * 1024;
            if (typeof this.fs.appendFile === 'function' && totalChars > CHUNK_LIMIT) {
              const chunks = [];
              let buf = '';
              for (let i = 0; i < jsonParts.length; i++) {
                const part = jsonParts[i];
                if (buf.length + part.length <= CHUNK_LIMIT) {
                  buf += part;
                } else {
                  if (buf.length > 0) {
                    chunks.push(buf);
                    buf = '';
                  }
                  if (part.length <= CHUNK_LIMIT) {
                    buf = part;
                  } else {
                    for (let offset = 0; offset < part.length; offset += CHUNK_LIMIT) {
                      chunks.push(part.slice(offset, offset + CHUNK_LIMIT));
                    }
                  }
                }
              }
              if (buf.length > 0) {
                chunks.push(buf);
              }

              let writtenChars = 0;
              for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
                const chunkStr = chunks[cIdx];
                if (cIdx === 0) {
                  await this.fs.writeFile(savePath, chunkStr);
                } else {
                  await this.fs.appendFile(savePath, chunkStr);
                }
                writtenChars += chunkStr.length;
                const pct = Math.min(98, 55 + Math.round((writtenChars / totalChars) * 43));
                this.showSavingBackdrop(
                  `세이브 백업 데이터를 내보내는 중... (${pct}%)`,
                  `백업 파일(${fileNameOnly})을 디스크에 기록하고 있습니다... (${formatByteLabel(
                    writtenChars
                  )} / ${sizeLabel})`,
                  { mode: 'loading', badgeText: '백업 데이터 내보내는 중', progress: pct }
                );
                await this.waitForBackdropPaint(16);
              }
            } else {
              const fullDumpStr = jsonParts.join('');
              await this.fs.writeFile(savePath, fullDumpStr);
            }

            const writeElapsed = Date.now() - writeStartMs;
            if (writeElapsed < 480) {
              await new Promise((r) => setTimeout(r, 480 - writeElapsed));
            }

            this.showSavingBackdrop(
              '세이브 백업 저장 완료!',
              `총 ${entries.length}개의 세이브 및 모드 설정(${sizeLabel})이 안전하게 저장되었습니다.\n저장 파일: ${fileNameOnly}`,
              { mode: 'success', badgeText: '백업 저장 완료 ✓' }
            );
            await this.waitForBackdropPaint(750);
            this.showActionToast(`세이브 백업 파일 저장 완료: ${savePath} (${sizeLabel})`, false);
            return {
              saved: true,
              path: savePath,
              byteLength: totalChars,
              totalKeys: entries.length,
            };
          }
        }

        if (typeof document !== 'undefined') {
          const dlStartMs = Date.now();
          this.showSavingBackdrop(
            '세이브 백업 데이터를 내보내는 중... (75%)',
            `세이브 및 모드 백업 파일(${defaultName} · ${sizeLabel})을 생성하여 내보내고 있습니다. 잠시만 기다려 주세요.`,
            { mode: 'loading', badgeText: '백업 데이터 내보내는 중', progress: 75 }
          );
          await this.waitForBackdropPaint(80);

          const blob = new Blob(jsonParts, { type: 'application/json;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = defaultName;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => {
            try {
              URL.revokeObjectURL(url);
            } catch (_) {}
          }, 5000);

          const dlElapsed = Date.now() - dlStartMs;
          if (dlElapsed < 500) {
            await new Promise((r) => setTimeout(r, 500 - dlElapsed));
          }

          this.showSavingBackdrop(
            '세이브 백업 저장 완료!',
            `총 ${entries.length}개의 세이브 및 모드 설정(${sizeLabel})을 백업 파일(${defaultName})로 내보냈습니다.`,
            { mode: 'success', badgeText: '백업 저장 완료 ✓' }
          );
          await this.waitForBackdropPaint(750);
          this.showActionToast(`세이브 백업 파일 저장 완료: ${defaultName} (${sizeLabel})`, false);
          return {
            saved: true,
            path: defaultName,
            byteLength: totalChars,
            totalKeys: entries.length,
          };
        }

        return { saved: false };
      } catch (err) {
        this.showSavingBackdrop(
          '세이브 백업 내보내기 실패',
          err && err.message ? err.message : '세이브 백업 파일을 저장하는 중 오류가 발생했습니다.',
          { mode: 'error', badgeText: '백업 내보내기 오류' }
        );
        await this.waitForBackdropPaint(850);
        this.showActionToast(
          `세이브 백업 내보내기 실패: ${err && err.message ? err.message : String(err)}`,
          true
        );
        throw err;
      } finally {
        this.hideSavingBackdrop(200);
      }
    }

    async safeExitApplication() {
      if (this.isClosing) return false;
      this.isClosing = true;
      this.showSavingBackdrop('종료 전 세이브 저장 및 확인 중...', '저장이 확인된 후 프로그램을 종료합니다.', { mode: 'loading', badgeText: '종료 전 저장 중' });
      let timer;
      try {
        const result = await Promise.race([
          this.flushAll({ checkpoint: true }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('저장 확인 시간이 초과되었습니다. 종료를 중단했습니다. 다시 시도해 주세요.')), 15000); }),
        ]);
        if (!result || !result.ok || this.dirtySqliteClear || this.dirtySqliteKeys.size || this.dirtySqliteDeletes.size ||
            this._gameAutosave && this._gameAutosave.pending)
          throw new Error('저장하지 못한 변경이 남아 있어 종료를 중단했습니다.');
        await this.shutdownSqliteExtension();
        this.showSavingBackdrop('세이브 저장 확인 완료!', '저장된 데이터를 확인했습니다. 프로그램을 종료합니다.', { mode: 'success', badgeText: '저장 확인 완료 ✓' });
        await this.waitForBackdropPaint(160);
        ensureNeutralinoEnvironment();
        if (global.Neutralino && global.Neutralino.app && typeof global.Neutralino.app.exit === 'function') await global.Neutralino.app.exit(0);
        else if (typeof window !== 'undefined') window.close();
        return true;
      } catch (err) {
        this.lastSaveError = err.message;
        this.isClosing = false;
        this.showSavingBackdrop('저장 확인 실패 — 종료를 중단했습니다', err.message, { mode: 'error', badgeText: '저장 재시도 필요' });
        this.showActionToast(err.message, true);
        this.hideSavingBackdrop(0);
        return false;
      } finally { if (timer) clearTimeout(timer); }
    }

    showGameConnectedBadge() {
      if (typeof window === 'undefined' || typeof document === 'undefined') return;
      if (!this.config.showGameBootToast) return;
      const pathname = (window.location && window.location.pathname) || '';
      if (!pathname || pathname.includes('launcher.html') || pathname.includes('extractor')) {
        return;
      }
      if (document.getElementById('__neu-storage-connected-toast')) return;

      const renderBadge = () => {
        if (!document.body || document.getElementById('__neu-storage-connected-toast')) return;
        const stats = this.getStats();
        const badge = document.createElement('div');
        badge.id = '__neu-storage-connected-toast';
        badge.style.cssText = [
          'position:fixed',
          'right:16px',
          'bottom:16px',
          'z-index:2147483646',
          'background:rgba(15,23,42,0.92)',
          'color:#e2e8f0',
          'border:1px solid rgba(16,185,129,0.5)',
          'border-radius:10px',
          'padding:8px 13px',
          'font-family:-apple-system,BlinkMacSystemFont,"Malgun Gothic",sans-serif',
          'font-size:12px',
          'box-shadow:0 10px 25px rgba(0,0,0,0.5)',
          'pointer-events:auto',
          'cursor:pointer',
          'transition:opacity 0.35s ease',
        ].join(';');
        badge.innerHTML = `<span style="color:#34d399;font-weight:700;">🟢 자동 세이브 보호 켜짐</span> · 저장 항목 <b>${stats.totalKeys}개</b>`;
        badge.onclick = () => badge.remove();
        document.body.appendChild(badge);
        setTimeout(() => {
          badge.style.opacity = '0';
          setTimeout(() => badge.remove(), 400);
        }, 3000);
      };

      if (document.body) {
        renderBadge();
      } else {
        window.addEventListener('DOMContentLoaded', renderBadge, { once: true });
      }
    }

    setupContextMenu() {
      if (
        typeof window === 'undefined' ||
        typeof window.addEventListener !== 'function' ||
        !this.config.enableContextMenu
      ) {
        return;
      }
      if (global.__NEU_CONTEXT_MENU_BOUND_VERSION__ === BRIDGE_VERSION) return;
      global.__NEU_CONTEXT_MENU_BOUND_VERSION__ = BRIDGE_VERSION;
      global.__NEU_CONTEXT_MENU_BOUND_V9__ = true;
      global.__NEU_CONTEXT_MENU_BOUND_V8__ = true;

      const closeMenu = () => {
        const existing = document.getElementById('__neu-custom-context-menu');
        if (existing) existing.remove();
      };

      if (typeof global.__NEU_CONTEXT_MENU_HANDLER_FN__ === 'function') {
        try {
          window.removeEventListener('contextmenu', global.__NEU_CONTEXT_MENU_HANDLER_FN__);
        } catch (_) {}
      }

      const contextMenuHandler = (e) => {
        const activeBridge = global.__storageBridge || this;
        if (e.shiftKey) {
          closeMenu();
          return;
        }

        e.preventDefault();
        closeMenu();

        if (!document.body) return;

        const stats = activeBridge.getStats();
        const isUnsaved = activeBridge.hasUnsavedChanges();
        const menu = document.createElement('div');
        menu.id = '__neu-custom-context-menu';
        menu.style.cssText = [
          'position:fixed',
          'z-index:2147483647',
          'min-width:275px',
          'background:#141821',
          'color:#f1f5f9',
          'border:1px solid #2e364f',
          'border-radius:11px',
          'padding:6px',
          'box-shadow:0 16px 40px rgba(0,0,0,0.65)',
          'font-family:-apple-system,BlinkMacSystemFont,"Malgun Gothic","맑은 고딕",sans-serif',
          'font-size:13px',
          'user-select:none',
          'backdrop-filter:blur(8px)',
        ].join(';');

        const statusHeader = document.createElement('div');
        statusHeader.style.cssText =
          'padding:6px 10px;margin-bottom:4px;border-radius:7px;background:#0f172a;border:1px solid #1e293b;font-size:11px;color:#34d399;font-weight:600;display:flex;align-items:center;justify-content:space-between;gap:8px;';
        statusHeader.innerHTML = `
          <span>${stats.lastSaveError ? '⚠ 마지막 저장 실패' : '자동 저장 켜짐'} (세이브 항목 ${stats.totalKeys}개)</span>
          <span style="color:${isUnsaved ? '#fbbf24' : '#94a3b8'};font-weight:500;">${
          stats.lastSaveError ? '다시 저장해 주세요' : isUnsaved ? '저장 중...' : '저장 완료'
        }</span>
        `;
        menu.appendChild(statusHeader);

        const items = [
          {
            id: 'go-launcher',
            label: '⚙️ 런처 화면으로 돌아가기',
            sub: '게임 파일 변경 · 세이브 관리',
            accent: '#60a5fa',
            onClick: async () => {
              await activeBridge.goToLauncherSettings();
            },
          },
          {
            id: 'open-extractor',
            label: '🌐 인터넷 창으로 백업 도구 열기',
            sub: '크롬·엣지에서 기존 세이브 추출하기',
            onClick: async () => {
              if (typeof window.__onLauncherOpenExtractor === 'function') {
                await window.__onLauncherOpenExtractor();
              } else {
                await activeBridge.openExtractorInExternalBrowser();
              }
            },
          },
          { divider: true },
          {
            id: 'import-backup',
            label: '📂 백업 파일 불러오기',
            sub: '보관해 둔 세이브·모드 데이터 복원',
            onClick: async () => {
              try {
                const res = await activeBridge.pickAndImportBackupFile();
                if (res && !res.cancelled) {
                  if (typeof window.__onLauncherBackupImported === 'function') {
                    window.__onLauncherBackupImported(res);
                  } else {
                    window.location.reload();
                  }
                }
              } catch (err) {
                console.error('[NeutralinoStorageBridge] 백업 불러오기 오류:', err);
              }
            },
          },
          {
            id: 'export-backup',
            label: '💾 현재 세이브 백업 저장하기',
            sub: '현재 진행 상황을 백업 파일로 따로 보관',
            onClick: async () => {
              try {
                await activeBridge.exportBackupFileWithPicker();
              } catch (err) {
                console.error('[NeutralinoStorageBridge] 백업 내보내기 오류:', err);
              }
            },
          },
          { divider: true },
          {
            id: 'reload-page',
            label: '🔄 현재 화면 새로고침',
            sub: '진행 내용을 저장한 뒤 화면 다시 불러오기',
            onClick: async () => {
              const t0 = Date.now();
              activeBridge.showSavingBackdrop(
                '세이브 데이터 저장 및 확인 중...',
                '진행 내용을 안전하게 저장한 뒤 화면을 다시 불러옵니다.',
                { mode: 'loading', badgeText: '세이브 보호 작동 중' }
              );
              await activeBridge.waitForBackdropPaint(70);
              await activeBridge.flushAll({ checkpoint: true });
              const elapsed = Date.now() - t0;
              if (elapsed < 450) {
                await new Promise((r) => setTimeout(r, 450 - elapsed));
              }
              activeBridge.saveSnapshotToWindowName();
              window.location.reload();
            },
          },
          {
            id: 'exit-app',
            label: '🚪 저장 후 프로그램 종료',
            sub: '진행 내용을 모두 저장한 뒤 안전하게 닫기',
            accent: '#fda4af',
            onClick: async () => {
              if (typeof window.__onLauncherSafeExit === 'function') {
                await window.__onLauncherSafeExit();
              } else {
                await activeBridge.safeExitApplication();
              }
            },
          },
        ];

        for (const item of items) {
          if (item.divider) {
            const hr = document.createElement('div');
            hr.style.cssText = 'height:1px;background:#262d40;margin:5px 4px;';
            menu.appendChild(hr);
            continue;
          }

          const btn = document.createElement('button');
          btn.type = 'button';
          btn.style.cssText = [
            'width:100%',
            'text-align:left',
            'padding:8px 10px',
            'border:none',
            'border-radius:7px',
            'background:transparent',
            'color:' + (item.accent || '#e2e8f0'),
            'cursor:pointer',
            'display:flex',
            'flex-direction:column',
            'gap:2px',
            'transition:background 0.12s ease',
          ].join(';');

          btn.innerHTML = `
            <span style="font-weight:600;font-size:13px;">${item.label}</span>
            ${item.sub ? `<span style="font-size:11px;color:#94a3b8;font-weight:400;">${item.sub}</span>` : ''}
          `;

          btn.onmouseenter = () => {
            btn.style.background = '#1e2638';
          };
          btn.onmouseleave = () => {
            btn.style.background = 'transparent';
          };
          btn.onclick = async (ev) => {
            ev.stopPropagation();
            closeMenu();
            try { await item.onClick(); }
            catch (err) {
              activeBridge.hideSavingBackdrop(0);
              activeBridge.showActionToast(err.message || String(err), true);
            }
          };

          menu.appendChild(btn);
        }

        const footerHint = document.createElement('div');
        footerHint.style.cssText =
          'padding:4px 10px 2px;font-size:10px;color:#64748b;text-align:right;';
        footerHint.textContent = 'Shift + 우클릭: 기본 메뉴';
        menu.appendChild(footerHint);

        document.body.appendChild(menu);

        const rect = menu.getBoundingClientRect();
        const maxX = window.innerWidth - rect.width - 8;
        const maxY = window.innerHeight - rect.height - 8;
        const posX = Math.max(8, Math.min(e.clientX, maxX));
        const posY = Math.max(8, Math.min(e.clientY, maxY));
        menu.style.left = `${posX}px`;
        menu.style.top = `${posY}px`;
      };

      global.__NEU_CONTEXT_MENU_HANDLER_FN__ = contextMenuHandler;
      window.addEventListener('contextmenu', contextMenuHandler);

      window.addEventListener('click', closeMenu);
      window.addEventListener('scroll', closeMenu, true);
      window.addEventListener('resize', closeMenu);
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeMenu();
      });
    }

    _setInternal(rawKey, rawValue, schedule = true) {
      if (this._awaitingReload) throw new Error('최신 세이브로 화면을 다시 불러오는 중입니다.');
      const key = String(rawKey);
      const val = String(rawValue);
      if (!this._gameAutosave || !this._gameAutosave.flushing) {
        if (this._gameAutosave && key === this._gameAutosave.key) this.cancelPendingGameAutosave(key);
        else this.flushPendingGameAutosave(key);
      }

      const prevVal = this.memory.get(key);
      if (prevVal === val) return;

      this.memory.set(key, val);
      this.revision++;
      this.keyRevisionMap.set(key, this.revision);
      this.lastModifiedAt = Date.now();

      // Neutralino(SQLite/디스크) 연결 환경에서는 64KB 초과 대용량 세이브를 IndexedDB에 중복 기록하지 않아 메인 스레드 프리징을 방지합니다.
      const maxDexieLen = this.config.rawStreamingThreshold || 65536;
      if (!this.isNeutralinoConnected() || val.length <= maxDexieLen) {
        this.dirtyDexieKeys.add(key);
        this.dirtyDexieDeletes.delete(key);
      } else {
        this.dirtyDexieKeys.delete(key);
      }

      this.dirtySqliteKeys.add(key);
      this.dirtySqliteDeletes.delete(key);

      if (schedule) {
        if (this.dirtyDexieKeys.size > 0) {
          this.scheduleDexieFlush();
        }
        this.scheduleSqliteFlush();
      }
    }

    _removeInternal(rawKey, schedule = true) {
      if (this._awaitingReload) throw new Error('최신 세이브로 화면을 다시 불러오는 중입니다.');
      const key = String(rawKey);
      this.cancelPendingGameAutosave(key);
      if (!this.memory.has(key) && (!this._metadataOnly || this.dirtySqliteClear || this.dirtySqliteDeletes.has(key) || !this._chunkManifests || !this._chunkManifests.has(key))) return;

      this.memory.delete(key);
      this.keyRevisionMap.delete(key);
      this.nodeHashesByKey.delete(key);
      this.nodeCountByKey.delete(key);

      this.revision++;
      this.lastModifiedAt = Date.now();

      this.dirtyDexieKeys.delete(key);
      this.dirtyDexieDeletes.add(key);

      this.dirtySqliteKeys.delete(key);
      this.dirtySqliteDeletes.add(key);

      if (schedule) {
        this.scheduleDexieFlush();
        this.scheduleSqliteFlush();
      }
    }

    _clearInternal(schedule = true) {
      if (this._awaitingReload) throw new Error('최신 세이브로 화면을 다시 불러오는 중입니다.');
      this.cancelPendingGameAutosave();
      if (this.storageKeys().length === 0) return;

      this.memory.clear();
      this.keyRevisionMap.clear();
      this.nodeHashesByKey.clear();
      this.nodeCountByKey.clear();

      this.pendingNodeUpsertsDexie.clear();
      this.pendingNodeDeletesDexie.clear();
      this.pendingNodeUpsertsSqlite.clear();
      this.pendingNodeDeletesSqlite.clear();

      this.dirtyDexieKeys.clear();
      this.dirtyDexieDeletes.clear();
      this.dirtyDexieClear = true;

      this.dirtySqliteKeys.clear();
      this.dirtySqliteDeletes.clear();
      this.dirtySqliteClear = true;

      this.revision++;
      this.lastModifiedAt = Date.now();

      if (schedule) {
        this.scheduleDexieFlush();
        this.scheduleSqliteFlush();
      }
    }

    async _preparePendingNodeDeltas(keysToProcess, now) {
      const largeItems = [];
      const inlineKvMeta = [];

      for (const k of keysToProcess) {
        if (!this.memory.has(k)) continue;
        const val = this.memory.get(k);
        if (this.shouldUseJsonTree(k, val)) {
          largeItems.push({ key: k, value: val });
        } else {
          const oldHashes = this.nodeHashesByKey.get(k);
          if (oldHashes) {
            for (const oldPath of oldHashes.keys()) {
              const compound = `${k}::${oldPath}`;
              this.pendingNodeDeletesDexie.add(compound);
              this.pendingNodeDeletesSqlite.set(compound, { rootKey: k, path: oldPath });
            }
            this.nodeHashesByKey.delete(k);
            this.nodeCountByKey.delete(k);
          }
          inlineKvMeta.push({
            key: k,
            storageMode: 'inline',
            valueText: val,
            byteLength: val.length,
            nodeCount: 1,
            revision: this.revision,
            updatedAt: now,
          });
        }
      }

      if (largeItems.length === 0) {
        return inlineKvMeta;
      }

      let deltaResults = null;
      if (this.deltaWorker) {
        try {
          const workerRes = await this.deltaWorker.call('computeDeltaBatch', {
            items: largeItems,
          });
          if (workerRes && Array.isArray(workerRes.results)) {
            deltaResults = workerRes.results;
          }
        } catch (_) {
          deltaResults = null;
        }
      }

      if (!deltaResults) {
        deltaResults = [];
        for (const it of largeItems) {
          const prevMap = this.nodeHashesByKey.get(it.key) || null;
          const d = computeKeyNodeDelta(it.key, it.value, prevMap);
          this.nodeHashesByKey.set(it.key, d.nextHashMap);
          deltaResults.push(d);
        }
      } else {
        for (const r of deltaResults) {
          if (r.plainHashes) {
            const m = new Map();
            for (const [p, h] of Object.entries(r.plainHashes)) {
              m.set(p, h);
            }
            this.nodeHashesByKey.set(r.key, m);
          }
        }
      }

      const allKvMeta = [...inlineKvMeta];
      for (let i = 0; i < deltaResults.length; i++) {
        const r = deltaResults[i];
        const k = largeItems[i].key;
        this.nodeCountByKey.set(k, r.nodeCount);

        const savedOnThisKey = Math.max(0, r.byteLength - r.deltaBytes);
        this.lastDeltaBytes = r.deltaBytes;
        this.lastDeltaNodes = r.nodeUpserts.length + r.nodeDeletes.length;
        this.totalSavedBytes += savedOnThisKey;

        for (const u of r.nodeUpserts) {
          const compound = `${u.rootKey}::${u.path}`;
          this.pendingNodeDeletesDexie.delete(compound);
          this.pendingNodeDeletesSqlite.delete(compound);

          this.pendingNodeUpsertsDexie.set(compound, {
            id: compound,
            rootKey: u.rootKey,
            path: u.path,
            hash: u.hash,
            valueJson: u.valueJson,
            updatedAt: now,
          });
          this.pendingNodeUpsertsSqlite.set(compound, {
            rootKey: u.rootKey,
            path: u.path,
            hash: u.hash,
            valueJson: u.valueJson,
            updatedAt: now,
          });
        }

        for (const d of r.nodeDeletes) {
          const compound = `${d.rootKey}::${d.path}`;
          this.pendingNodeUpsertsDexie.delete(compound);
          this.pendingNodeUpsertsSqlite.delete(compound);

          this.pendingNodeDeletesDexie.add(compound);
          this.pendingNodeDeletesSqlite.set(compound, {
            rootKey: d.rootKey,
            path: d.path,
          });
        }

        allKvMeta.push({
          key: k,
          storageMode: 'json_tree',
          valueText: null,
          byteLength: r.byteLength,
          nodeCount: r.nodeCount,
          revision: this.revision,
          updatedAt: now,
        });
      }

      return allKvMeta;
    }

    scheduleDexieFlush() {
      this.initDexieDatabase();
      if (!this.dexieDb) return;
      if (this.dexieTimer) {
        clearTimeout(this.dexieTimer);
      }
      this.dexieTimer = setTimeout(() => {
        this.dexieTimer = null;
        this.flushDexie().catch((err) => this.log('Dexie 백그라운드 저장 오류:', err));
      }, this.config.debounceDexieMs);
    }

    async flushDexie() {
      this.initDexieDatabase();
      if (!this.dexieDb) return;
      if (this.dexieTimer) {
        clearTimeout(this.dexieTimer);
        this.dexieTimer = null;
      }

      if (this.dexieFlushPromise) {
        try {
          await this.dexieFlushPromise;
        } catch (_) {}
      }

      if (
        !this.dirtyDexieClear &&
        this.dirtyDexieKeys.size === 0 &&
        this.dirtyDexieDeletes.size === 0
      ) {
        return;
      }

      const shouldClear = this.dirtyDexieClear;
      const dirtyKeys = Array.from(this.dirtyDexieKeys);
      const deletes = Array.from(this.dirtyDexieDeletes);
      const snapRevision = this.revision;
      const snapUpdatedAt = this.lastModifiedAt || Date.now();
      const maxDexieLen = this.config.rawStreamingThreshold || 65536;
      const isNeu = this.isNeutralinoConnected();

      this.dirtyDexieClear = false;
      this.dirtyDexieKeys.clear();
      this.dirtyDexieDeletes.clear();
      this.pendingNodeUpsertsDexie.clear();
      this.pendingNodeDeletesDexie.clear();

      const kvRecords = [];
      for (const k of dirtyKeys) {
        if (!this.memory.has(k)) continue;
        const val = this.memory.get(k);
        if (isNeu && val.length > maxDexieLen) continue;
        kvRecords.push({
          key: k,
          storageMode: 'inline',
          value: val,
          byteLength: val.length,
          nodeCount: 1,
          updatedAt: snapUpdatedAt,
        });
      }

      const runTx = async () => {
        await this.dexieDb.open();
        await this.dexieDb.transaction(
          'rw',
          this.dexieDb.kv,
          this.dexieDb.nodes,
          this.dexieDb.meta,
          async () => {
            if (shouldClear) {
              await this.dexieDb.kv.clear();
              if (this.dexieDb.nodes) await this.dexieDb.nodes.clear();
            } else if (deletes.length > 0) {
              await this.dexieDb.kv.bulkDelete(deletes);
            }
            if (kvRecords.length > 0) {
              await this.dexieDb.kv.bulkPut(kvRecords);
            }
            await this.dexieDb.meta.put({
              key: 'state',
              revision: snapRevision,
              updatedAt: snapUpdatedAt,
              syncedToSqlite: true,
            });
          }
        );
        this.lastDexieSyncedAt = Date.now();
      };

      const p = runTx().finally(() => {
        if (this.dexieFlushPromise === p) {
          this.dexieFlushPromise = null;
        }
      });
      this.dexieFlushPromise = p;
      await p;
    }

    scheduleSqliteFlush() {
      if (!this.isNeutralinoConnected()) return;
      if (this._autoFlushRunning) return;
      if (this.sqliteTimer) {
        clearTimeout(this.sqliteTimer);
      }
      if (this.sqliteIdleHandle && typeof cancelIdleCallback === 'function') {
        try {
          cancelIdleCallback(this.sqliteIdleHandle);
        } catch (_) {}
        this.sqliteIdleHandle = null;
      }

      if (!this._firstDirtyAt) this._firstDirtyAt = Date.now();
      const remaining = Math.max(0, (this.config.maxFlushWaitMs || 5000) - (Date.now() - this._firstDirtyAt));
      this.sqliteTimer = setTimeout(() => {
        this.sqliteTimer = null;
        const triggerWrite = () => {
          this.sqliteIdleHandle = null;
          this._firstDirtyAt = 0;
          this._autoFlushRunning = true;
          this.flushSqlite().catch((err) => this.log('SQLite Extension 동기화 오류:', err)).finally(() => {
            this._autoFlushRunning = false;
            if (!this.isClosing && !this.lastSaveError && (this.dirtySqliteClear || this.dirtySqliteKeys.size || this.dirtySqliteDeletes.size)) {
              this._firstDirtyAt = Date.now() - (this.config.maxFlushWaitMs || 5000);
              this.scheduleSqliteFlush();
            }
          });
        };

        const idleBudget = Math.max(0, (this.config.maxFlushWaitMs || 5000) - (Date.now() - this._firstDirtyAt));
        if (typeof requestIdleCallback === 'function' && idleBudget > 0) {
          this.sqliteIdleHandle = requestIdleCallback(triggerWrite, { timeout: Math.min(2000, idleBudget) });
        } else {
          triggerWrite();
        }
      }, Math.min(this.config.debounceSqliteMs, remaining));
    }

    async flushSqlite(options = {}) {
      if (!this.isNeutralinoConnected()) throw new Error('영구 저장소에 연결되어 있지 않습니다.');
      if (!options.initializing && !this.initialized) await this.init();
      if (this._storageLoadError) throw this._storageLoadError;
      if (this.sqliteTimer) { clearTimeout(this.sqliteTimer); this.sqliteTimer = null; }
      if (this.sqliteIdleHandle && typeof cancelIdleCallback === 'function') { cancelIdleCallback(this.sqliteIdleHandle); this.sqliteIdleHandle = null; }
      while (this.sqliteFlushPromise) await this.sqliteFlushPromise;
      this.flushPendingGameAutosave();
      if (this.config.chunkStorage !== false) return await this.flushChunkSnapshot(options);
      if (this._verifiedSqliteCommit && this._verifiedSqliteCommit.format === 22) { await this.ensureDataLoaded(); this.dirtySqliteClear = true; }
      const run = async () => {
        const full = this.dirtySqliteClear || !this._verifiedSqliteCommit;
        const keys = full ? Array.from(this.memory.keys()) : Array.from(this.dirtySqliteKeys);
        const deletes = Array.from(this.dirtySqliteDeletes);
        if (!full && !keys.length && !deletes.length) return { ok: true, commit: this._verifiedSqliteCommit };
        const values = new Map(this.memory);
        const revision = this.revision;
        const updatedAt = this.lastModifiedAt || Date.now();
        const id = global.crypto && typeof global.crypto.randomUUID === 'function' ? global.crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
        const expectedHashes = await this.hashStorageValues(values);
        const payload = { id, baseId: this._sqliteBaseId || '', revision, updatedAt, clearAll: full,
          kvDeletes: deletes, kvUpserts: keys.filter((k) => values.has(k)).map((k) => ({ key: k, valueText: values.get(k) })),
          expectedHashes, legacyUpdatedAt: this._legacyImportedAt || 0, checkpoint: Boolean(options.checkpoint) };
        if (!this.sqliteConnected && !await this.ensureSqliteExtensionInstalledAndRunning()) throw new Error('SQLite 저장 서버에 연결하지 못했습니다.');
        let response = await this.callSqliteExtension('commitSave', payload, 60000);
        const commitError = response && response.error || this._lastSqliteError;
        // A lost reply can follow a successful commit; confirm its id before retrying.
        if (!response || !response.ok) {
          const exported = await this.callSqliteExtension('exportMeta', {}, 60000);
          if (exported && exported.saveCommit && exported.saveCommit.id === id) response = { ok: true, commit: exported.saveCommit };
        }
        const commit = response && response.commit;
        if (!response || !response.ok || !commit || commit.id !== id || commit.verified !== true ||
          !this.sameStorageHashes(expectedHashes, commit.hashes)) throw new Error(commitError || 'SQLite 커밋 검증에 실패했습니다. 변경 내용은 재시도를 위해 유지됩니다.');
        this._verifiedSqliteCommit = commit;
        this._chunkManifests = null;
        this._sqliteBaseId = commit.id;
        this.lastSqliteSyncedAt = Date.now();
        this.lastSaveError = null;
        // Preserve all edits, deletions and clear() operations that happened in flight.
        if (this.revision === revision) this.dirtySqliteClear = false;
        for (const k of keys) if (this.memory.has(k) && this.memory.get(k) === values.get(k)) this.dirtySqliteKeys.delete(k);
        for (const k of deletes) if (!this.memory.has(k)) this.dirtySqliteDeletes.delete(k);
        this.pendingNodeUpsertsSqlite.clear(); this.pendingNodeDeletesSqlite.clear();
        this.lastDeltaBytes = payload.kvUpserts.reduce((n, v) => n + v.valueText.length, 0);
        this.lastDeltaNodes = payload.kvUpserts.length;
        return { ok: true, commit };
      };
      const pending = run().catch((err) => { this.lastSaveError = err.message; throw err; });
      this.sqliteFlushPromise = pending;
      try { return await pending; }
      finally { if (this.sqliteFlushPromise === pending) this.sqliteFlushPromise = null; }
    }

    async flushAll(options = {}) {
      this.flushPendingGameAutosave();
      // IndexedDB is a cache; durable success is determined only by SQLite.
      try { await this.flushDexie(); } catch (err) { this.log('캐시 저장 오류:', err); }
      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        result = await this.flushSqlite(options);
        if (!this.dirtySqliteClear && !this.dirtySqliteKeys.size && !this.dirtySqliteDeletes.size &&
            !(this._gameAutosave && this._gameAutosave.pending)) return result;
      }
      throw new Error('저장 중 새 변경이 발생했습니다. 저장을 다시 시도해 주세요.');
    }

    installProxy() {
      const self = this;

      const apiMethods = {
        getItem(key) {
          if (arguments.length === 0) {
            throw new TypeError(
              "Failed to execute 'getItem' on 'Storage': 1 argument required, but only 0 present."
            );
          }
          const k = String(key);
          return self.readStorageValueSync(k);
        },
        setItem(key, value) {
          if (arguments.length < 2) {
            throw new TypeError(
              "Failed to execute 'setItem' on 'Storage': 2 arguments required."
            );
          }
          self._setInternal(key, value, true);
        },
        removeItem(key) {
          if (arguments.length === 0) {
            throw new TypeError(
              "Failed to execute 'removeItem' on 'Storage': 1 argument required, but only 0 present."
            );
          }
          self._removeInternal(key, true);
        },
        clear() {
          self._clearInternal(true);
        },
        key(index) {
          if (arguments.length === 0) {
            throw new TypeError(
              "Failed to execute 'key' on 'Storage': 1 argument required, but only 0 present."
            );
          }
          const idx = Number(index) >>> 0;
          const keys = self.storageKeys();
          return idx < keys.length ? keys[idx] : null;
        },
      };

      const target = Object.create(
        typeof Storage !== 'undefined' ? Storage.prototype : Object.prototype
      );

      this.proxy = new Proxy(target, {
        get(_target, prop) {
          if (prop === 'length') {
            return self.storageKeys().length;
          }
          if (
            typeof prop === 'string' &&
            Object.prototype.hasOwnProperty.call(apiMethods, prop)
          ) {
            // Mod loaders wrap Storage.prototype to unpack reads and pack writes.
            // Look up the current method on each access; its captured base method
            // still calls apiMethods directly, preserving raw storage without recursion.
            const method = Reflect.get(_target, prop, self.proxy);
            return method === undefined ? apiMethods[prop] : method;
          }
          if (prop === Symbol.toStringTag) {
            return 'Storage';
          }
          if (typeof prop === 'symbol') {
            return Reflect.get(_target, prop);
          }
          return self.storageKeys().includes(prop) ? self.readStorageValueSync(prop) : undefined;
        },

        set(_target, prop, value) {
          if (
            typeof prop === 'symbol' ||
            Object.prototype.hasOwnProperty.call(apiMethods, prop) ||
            prop === 'length'
          ) {
            return false;
          }
          self._setInternal(prop, value, true);
          return true;
        },

        deleteProperty(_target, prop) {
          if (typeof prop === 'string' && self.storageKeys().includes(prop)) {
            self._removeInternal(prop, true);
          }
          return true;
        },

        has(_target, prop) {
          if (prop === 'length' || Object.prototype.hasOwnProperty.call(apiMethods, prop)) {
            return true;
          }
          return typeof prop === 'string' && self.storageKeys().includes(prop);
        },

        ownKeys() {
          return self.storageKeys();
        },

        getOwnPropertyDescriptor(_target, prop) {
          if (typeof prop === 'string' && self.storageKeys().includes(prop)) {
            return {
              value: self.readStorageValueSync(prop),
              writable: true,
              enumerable: true,
              configurable: true,
            };
          }
          return undefined;
        },
      });

      try {
        Object.defineProperty(global, 'localStorage', {
          configurable: true,
          enumerable: true,
          get: () => this.proxy,
        });
      } catch (_) {}

      try {
        if (typeof Window !== 'undefined' && Window.prototype) {
          Object.defineProperty(Window.prototype, 'localStorage', {
            configurable: true,
            enumerable: true,
            get: () => this.proxy,
          });
        }
      } catch (_) {}

      if (typeof Storage !== 'undefined' && Storage.prototype && nativeStorageMethods) {
        try {
          Storage.prototype.getItem = function (key) {
            if (this === nativeSessionStorage && nativeStorageMethods.getItem) {
              return nativeStorageMethods.getItem.apply(this, arguments);
            }
            return apiMethods.getItem.apply(self.proxy, arguments);
          };
          Storage.prototype.setItem = function (key, val) {
            if (this === nativeSessionStorage && nativeStorageMethods.setItem) {
              return nativeStorageMethods.setItem.apply(this, arguments);
            }
            return apiMethods.setItem.apply(self.proxy, arguments);
          };
          Storage.prototype.removeItem = function (key) {
            if (this === nativeSessionStorage && nativeStorageMethods.removeItem) {
              return nativeStorageMethods.removeItem.apply(this, arguments);
            }
            return apiMethods.removeItem.apply(self.proxy, arguments);
          };
          Storage.prototype.clear = function () {
            if (this === nativeSessionStorage && nativeStorageMethods.clear) {
              return nativeStorageMethods.clear.apply(this, arguments);
            }
            return apiMethods.clear.apply(self.proxy, arguments);
          };
          Storage.prototype.key = function (idx) {
            if (this === nativeSessionStorage && nativeStorageMethods.key) {
              return nativeStorageMethods.key.apply(this, arguments);
            }
            return apiMethods.key.apply(self.proxy, arguments);
          };
          Object.defineProperty(Storage.prototype, 'length', {
            configurable: true,
            enumerable: true,
            get() {
              if (
                this === nativeSessionStorage &&
                nativeStorageMethods.lengthDescriptor &&
                nativeStorageMethods.lengthDescriptor.get
              ) {
                return nativeStorageMethods.lengthDescriptor.get.call(this);
              }
              return self.storageKeys().length;
            },
          });
        } catch (_) {}
      }
    }

    setupLifecycleHooks() {
      if (!this.config.hookWindowClose || this.lifecycleHooked) return;
      ensureNeutralinoEnvironment();
      if (!this.isNeutralinoConnected()) return;

      this.lifecycleHooked = true;

      const handleClose = (ev) => {
        if (ev && typeof ev.preventDefault === 'function') {
          try {
            ev.preventDefault();
          } catch (_) {}
        }
        this.safeExitApplication();
      };

      const handleSqliteRpcResponse = (ev) => {
        const detail = (ev && ev.detail) || {};
        const reqId = detail.reqId;
        if (reqId && this.sqliteWsPending.has(reqId)) {
          const entry = this.sqliteWsPending.get(reqId);
          this.sqliteWsPending.delete(reqId);
          if (entry.timer) clearTimeout(entry.timer);
          entry.resolve(detail.result);
        }
      };

      let nativeEventsRegistered = false;
      if (
        global.Neutralino &&
        global.Neutralino.events &&
        typeof global.Neutralino.events.on === 'function'
      ) {
        try {
          global.Neutralino.events.on('windowClose', handleClose);
          global.Neutralino.events.on('neuSqliteRpcResponse', handleSqliteRpcResponse);
          nativeEventsRegistered = true;
        } catch (_) {}
      }

      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        if (!nativeEventsRegistered) {
          window.addEventListener('windowClose', handleClose);
          window.addEventListener('neuSqliteRpcResponse', handleSqliteRpcResponse);
        }
        window.addEventListener(
          'keydown',
          (e) => {
            if (e.altKey && e.key === 'F4') {
              e.preventDefault();
              this.safeExitApplication();
            }
          },
          true
        );
        window.addEventListener('beforeunload', () => {
          if (this.hasUnsavedChanges()) {
            this.flushAll().catch(() => {});
          }
        });
        window.addEventListener('pagehide', () => {
          if (this.hasUnsavedChanges()) {
            this.flushAll().catch(() => {});
          }
        });
      }
      // Subscribe before connecting so a close event cannot arrive without a handler.
      if (global.Neutralino && typeof global.Neutralino.init === 'function') {
        global.Neutralino.init();
      }
    }

    async importDump(dumpObjOrJsonString, clearExisting = false) {
      if (!clearExisting) await this.ensureDataLoaded();
      const obj =
        typeof dumpObjOrJsonString === 'string'
          ? JSON.parse(dumpObjOrJsonString)
          : dumpObjOrJsonString;

      if (this._gameAutosave && (clearExisting || Object.prototype.hasOwnProperty.call(obj, this._gameAutosave.key))) {
        this.cancelPendingGameAutosave();
        // The still-running game holds the pre-import state. Resume its autosave
        // only after the persistence layer reads the replacement or the page reloads.
        this._gameAutosaveSuspended = true;
      }

      if (clearExisting) {
        this._clearInternal(false);
      }
      for (const [k, v] of Object.entries(obj)) {
        this._setInternal(k, v, false);
      }
      await this.flushAll({ checkpoint: true });
    }

    exportDump() {
      this.flushPendingGameAutosave();
      if (this._metadataOnly) for (const key of this.storageKeys()) this.readStorageValueSync(key);
      const out = {};
      for (const [k, v] of this.memory.entries()) {
        out[k] = v;
      }
      return out;
    }

    getStats() {
      let inlineBytes = 0;
      let externalBytes = 0;
      let totalJsonNodes = 0;
      const externalFiles = {};
      const items = [];

      const largeThreshold = this.config.jsonTreeThreshold || 32768;
      const descriptors = new Map(Array.from(this._chunkManifests || [], ([k,m]) => [k,m.chars]));
      if (this.dirtySqliteClear) descriptors.clear();
      for (const [k,v] of this.memory) descriptors.set(k,v.length);
      for (const k of this.dirtySqliteDeletes) descriptors.delete(k);
      for (const [k, chars] of descriptors) {
        const len = chars;
        const isLargeItem = len >= largeThreshold;
        items.push({
          key: k,
          chars: len,
          isLarge: isLargeItem,
        });
        if (isLargeItem) {
          externalBytes += len;
          totalJsonNodes += 1;
          externalFiles[k] = {
            file: 'storage.sqlite',
            chars: len,
            nodeCount: 1,
          };
        } else {
          inlineBytes += len;
        }
      }

      items.sort((a, b) => b.chars - a.chars || a.key.localeCompare(b.key));

      return {
        totalKeys: descriptors.size,
        inlineKeys: descriptors.size - Object.keys(externalFiles).length,
        externalKeys: Object.keys(externalFiles).length,
        inlineChars: inlineBytes,
        externalChars: externalBytes,
        externalFiles,
        items,
        totalJsonNodes,
        chunkMetrics: this.chunkMetrics || null,
        autosaveMetrics: this._gameAutosave ? this._gameAutosave.stats() : null,
        metadataOnly: Boolean(this._metadataOnly),
        lastDeltaBytes: this.lastDeltaBytes,
        lastDeltaNodes: this.lastDeltaNodes,
        totalSavedBytes: this.totalSavedBytes,
        dexieLoaded: Boolean(this.dexieDb),
        isExternalDexieLoaded: Boolean(this.isExternalDexieLoaded),
        sqliteConnected: Boolean(this.sqliteConnected),
        sqliteBackendName: this.sqliteBackendName || null,
        unsavedChanges: this.hasUnsavedChanges(),
      };
    }
  }

  NeutralinoStorageBridge.decomposeJsonBottomUp = decomposeJsonBottomUp;
  NeutralinoStorageBridge.reconstructJsonBottomUp = reconstructJsonBottomUp;
  NeutralinoStorageBridge.computeKeyNodeDelta = computeKeyNodeDelta;

  global.NeutralinoStorageBridge = NeutralinoStorageBridge;
  global.__ensureNeutralinoEnvironment = ensureNeutralinoEnvironment;

  if (typeof window !== 'undefined') {
    try {
      ensureNeutralinoEnvironment();
      disableDesktopServiceWorkers();
      const autoBridge = new NeutralinoStorageBridge();
      if (previousBridge && previousBridge !== autoBridge) {
        const methodsToUpgrade = [
          'showSavingBackdrop',
          'waitForBackdropPaint',
          'hideSavingBackdrop',
          'showActionToast',
          'exportBackupFileWithPicker',
          'pickAndImportBackupFile',
          'importRawBackupText',
          'pickGameHtmlFile',
          'goToLauncherSettings',
          'safeExitApplication',
          'getStats',
        ];
        for (const mName of methodsToUpgrade) {
          if (typeof autoBridge[mName] === 'function') {
            previousBridge[mName] = autoBridge[mName].bind(autoBridge);
          }
        }
      }
      global.__storageBridge = autoBridge;

      const pathname = (window.location && window.location.pathname) || '';
      const isExtractorPage = /extractor/i.test(pathname);
      const isLauncherPage = Boolean(
        global.__IS_WAYWARD_LAUNCHER_UI__ || /launcher\.html/i.test(pathname)
      );
      const bootStartMs = Date.now();

      // 가장 먼저 동기식 부트스트랩(SQLite / window.name 로드)을 실행하여
      // 게임 스크립트가 시작되기 전에 localStorage 메모리를 100% 채웁니다.
      autoBridge.bootstrapSyncIfPossible();

      if (!isExtractorPage && !isLauncherPage) {
        try {
          autoBridge.showSavingBackdrop(
            '저장된 데이터 불러오는 중...',
            '게임 세이브와 모드 설정을 불러오고 있습니다. 잠시만 기다려 주세요.',
            { mode: 'loading', badgeText: '세이브 데이터 준비 중' }
          );
        } catch (_) {}
      }

      try {
        autoBridge.showGameConnectedBadge();
      } catch (_) {}

      if (!isExtractorPage && !isLauncherPage) {
        const initPromise = autoBridge.init();
        const domReadyPromise = new Promise((resolve) => {
          const timer = setTimeout(resolve, 1500);
          if (typeof document !== 'undefined' && document.readyState !== 'loading') {
            clearTimeout(timer);
            resolve();
          } else if (typeof window.addEventListener === 'function') {
            window.addEventListener(
              'DOMContentLoaded',
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true }
            );
          } else {
            clearTimeout(timer);
            resolve();
          }
        });

        Promise.all([initPromise, domReadyPromise])
          .then(async () => {
            if (autoBridge.isClosing) return;
            const elapsed = Date.now() - bootStartMs;
            if (elapsed < 450) {
              await new Promise((r) => setTimeout(r, 450 - elapsed));
            }
            if (autoBridge.isClosing) return;
            const stats = autoBridge.getStats();
            autoBridge.showSavingBackdrop(
              '데이터 불러오기 완료!',
              `총 ${stats.totalKeys}개의 세이브 및 모드 설정이 준비되었습니다.`,
              { mode: 'success', badgeText: '불러오기 완료 ✓' }
            );
            await autoBridge.waitForBackdropPaint(200);
          })
          .catch((err) => {
            autoBridge.showActionToast('저장소 준비 실패: ' + err.message, true);
          })
          .finally(() => {
            if (!autoBridge.isClosing) {
              autoBridge.hideSavingBackdrop(200);
            }
          });
      }

      if (typeof window.addEventListener === 'function') {
        window.addEventListener('DOMContentLoaded', () => {
          autoBridge.ensureReady();
          autoBridge.showGameConnectedBadge();
        });
        window.addEventListener('load', () => {
          autoBridge.ensureReady();
        });
      }
    } catch (err) {
      console.error('[NeutralinoStorageBridge] 부트스트랩 오류:', err);
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
