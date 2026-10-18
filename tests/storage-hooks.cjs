const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { makeBridge } = require('./storage-recovery.cjs');
const { createStorageChunkCodec } = require('../storage-chunks.js');

function installProxy(pair) {
  class Storage {
    constructor() { this.values = new Map(); }
    getItem(key) { return this.values.get(String(key)) ?? null; }
    setItem(key, value) { this.values.set(String(key), String(value)); }
    removeItem(key) { this.values.delete(String(key)); }
    clear() { this.values.clear(); }
    key(index) { return Array.from(this.values.keys())[index] ?? null; }
    get length() { return this.values.size; }
  }
  const session = new Storage();
  const nativeStorageMethods = Object.fromEntries(['getItem', 'setItem', 'removeItem', 'clear', 'key'].map(name => [name, Storage.prototype[name]]));
  nativeStorageMethods.lengthDescriptor = Object.getOwnPropertyDescriptor(Storage.prototype, 'length');
  Object.assign(pair.context, { Storage, nativeSessionStorage: session, nativeStorageMethods });
  Object.assign(pair.bridge, { scheduleDexieFlush() {}, scheduleSqliteFlush() {} });
  Object.getPrototypeOf(pair.bridge).installProxy.call(pair.bridge);
  return { Storage, session };
}

const prefix = 'test-packed:';
const pack = value => prefix + Buffer.from(value).toString('base64');
function hookReader(Storage, proxy) {
  const rawGet = Storage.prototype.getItem;
  const cache = new Map();
  let decodes = 0;
  Storage.prototype.getItem = function (key) {
    const raw = rawGet.call(this, key);
    if (this !== proxy || typeof raw !== 'string' || !raw.startsWith(prefix)) return raw;
    if (cache.get(key)?.raw === raw) return cache.get(key).plain;
    decodes++;
    const plain = Buffer.from(raw.slice(prefix.length), 'base64').toString();
    cache.set(key, { raw, plain });
    return plain;
  };
  return { rawGet, decodes: () => decodes };
}

async function test() {
  const folder = fs.mkdtempSync(path.join(__dirname, '../.tmp/chunk-storage/hooks-'));
  const pair = makeBridge(folder);
  const { bridge } = pair;
  const { Storage, session } = installProxy(pair);
  const hooks = hookReader(Storage, bridge.proxy);
  const plain = JSON.stringify({ state: { day: 12 }, format: 1 });
  const packed = pack(plain);
  bridge.memory.set('manual', packed);
  bridge.memory.set('automatic', plain);
  assert.equal(bridge.proxy.getItem('manual'), plain);
  assert.equal(bridge.proxy.getItem('manual'), plain);
  assert.equal(hooks.decodes(), 1);
  assert.equal(bridge.proxy.getItem('automatic'), plain);
  assert.equal(hooks.rawGet.call(bridge.proxy, 'manual'), packed);
  assert.equal(bridge.memory.get('manual'), packed, 'decoding must not rewrite the stored value');
  assert.throws(() => hooks.rawGet.call(bridge.proxy), /1 argument required/);

  const baseSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) { return baseSet.call(this, key, pack(String(value))); };
  const newer = JSON.stringify({ state: { day: 13 }, format: 1 });
  bridge.proxy.setItem('manual', newer);
  assert.equal(bridge.memory.get('manual'), pack(newer));
  assert.equal(bridge.proxy.getItem('manual'), newer);
  assert.equal(hooks.decodes(), 2, 'the loader can invalidate its decoded cache after a write');
  Storage.prototype.setItem = baseSet;
  bridge.proxy.setItem('plain', plain);
  assert.equal(bridge.memory.get('plain'), plain);
  const unpackingGet = Storage.prototype.getItem;
  Storage.prototype.getItem = function (key) { return 'temporary:' + unpackingGet.call(this, key); };
  assert.equal(bridge.proxy.getItem('plain'), 'temporary:' + plain);
  Storage.prototype.getItem = unpackingGet;
  assert.equal(bridge.proxy.getItem('plain'), plain);
  session.setItem('native', 'session-value');
  assert.equal(session.getItem('native'), 'session-value');
  assert.equal(session.length, 1);
  assert(!bridge.memory.has('native'));
  console.log('PASS dynamic prototype read/write hooks, captured raw methods, decoded cache invalidation and session storage');

  const values = { settings: 'small', 'tavern-game': JSON.stringify({ state: { text: 'x'.repeat(100000) } }), 'tavern-slot-0': pack(JSON.stringify({ state: { text: 'y'.repeat(100000) } })), utf16: 'x\ud800y' };
  const codec = createStorageChunkCodec();
  const manifests = Object.fromEntries(await Promise.all(Object.entries(values).map(async ([key, value]) => [key, (await codec.encode(value)).manifest])));
  const commit = { id: 'catalog-save', format: 22, revision: 7, updatedAt: 200, legacyUpdatedAt: 100, keyCount: 4, verified: true, hashes: Object.fromEntries(Object.entries(manifests).map(([key, value]) => [key, value.root])) };
  const meta = { ok: true, saveCommit: commit, values: manifests, inlineData: { settings: values.settings }, largeKeys: ['tavern-game', 'tavern-slot-0', 'utf16'] };
  const bodyReads = [];
  const lazy = makeBridge(folder, { window: { name: '', location: { pathname: '/game.html' } }, syncGet(url) {
    if (url.endsWith('storage.json')) return JSON.stringify({ __updatedAt__: 100, data: {} });
    if (url.endsWith('sqlite-endpoint.json')) return '{"url":"http://test"}';
    if (url.endsWith('export-meta')) return JSON.stringify(meta);
    if (url.includes('/get-text?')) return 'malformed-json-response';
    if (url.includes('/get-raw?')) { const request = new URL(url); assert.equal(request.searchParams.get('saveId'), commit.id); const key = request.searchParams.get('key'); bodyReads.push(key); return values[key]; }
    return null;
  } });
  lazy.globalStub.__IS_WAYWARD_LAUNCHER_UI__ = false;
  lazy.bridge.config.chunkStorage = true;
  const { Storage: LazyStorage } = installProxy(lazy);
  hookReader(LazyStorage, lazy.bridge.proxy);
  assert(lazy.bridge.bootstrapSyncIfPossible());
  assert.deepEqual(bodyReads, []);
  assert.equal(lazy.bridge.memory.size, 1);
  assert.equal(lazy.bridge.proxy.length, 4);
  assert('tavern-slot-0' in lazy.bridge.proxy);
  lazy.bridge.ensureSqliteExtensionInstalledAndRunning = async () => { lazy.bridge.sqliteConnected = true; return true; };
  lazy.bridge.customSqliteStore = async action => { assert.equal(action, 'exportMeta'); return meta; };
  lazy.bridge.loadChunkValues = () => { throw new Error('Unexpected full startup restore'); };
  await lazy.bridge.init();
  assert.deepEqual(bodyReads, []);
  assert.equal(lazy.bridge.proxy.getItem('tavern-game'), values['tavern-game']);
  assert.deepEqual(bodyReads, ['tavern-game']);
  assert.equal(lazy.bridge.proxy.getItem('tavern-game'), values['tavern-game']);
  assert.deepEqual(bodyReads, ['tavern-game']);
  const restored = lazy.bridge.proxy.getItem('tavern-slot-0');
  assert.equal(JSON.parse(restored).state.text, 'y'.repeat(100000));
  assert.equal(lazy.bridge.memory.get('tavern-slot-0'), values['tavern-slot-0']);
  assert.deepEqual(bodyReads, ['tavern-game', 'tavern-slot-0']);
  assert.equal(lazy.bridge.dirtySqliteKeys.size, 0);
  console.log('PASS game startup reads only metadata; large values load once on demand through the loader hook');
  assert.throws(() => lazy.bridge.proxy.getItem('utf16'));
  assert(lazy.bridge._storageLoadError);
  assert(!lazy.bridge.memory.has('utf16'));
  await assert.rejects(lazy.bridge.flushAll());
  console.log('PASS failed deferred reads block commits and never cache partial data');
}

if (require.main === module) test().catch(error => { console.error(error.stack); process.exitCode = 1; });
