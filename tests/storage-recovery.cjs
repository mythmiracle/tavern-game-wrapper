const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { webcrypto, createHash } = require('crypto');
const { createStorageChunkCodec } = require('../storage-chunks.js');
global.createStorageChunkCodec = createStorageChunkCodec;
const { createStorageChunkWorker } = require('../storage-chunk-worker.js');
const assert = require('assert/strict');
const { getSources } = require('../scripts/storage-sources.cjs');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'neutralino-storage-bridge.js'), 'utf8');
const classText = source.slice(source.indexOf('  class NeutralinoStorageBridge {'), source.indexOf('  NeutralinoStorageBridge.decomposeJsonBottomUp'));
const defaultsText = source.slice(source.indexOf('  const DEFAULT_CONFIG = ') + 25, source.indexOf('\n  };', source.indexOf('  const DEFAULT_CONFIG')) + 4).replace(/;\s*$/, '');
const defaults = vm.runInNewContext(`(${defaultsText})`);
const runner = path.join(root, '.tmp/save-recovery/backend-runner.exe');
function backend(db, action, payload = {}) {
  const result = spawnSync(runner, [db, action], { input: JSON.stringify(payload), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr);
  return JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
}
function makeBridge(dir, extra = {}) {
  const globalStub = { NL_PATH: dir, __IS_WAYWARD_LAUNCHER_UI__: true, crypto: webcrypto, Neutralino: { app: { exit: async () => { globalStub.exitCount++; } } }, exitCount: 0 };
  const context = { global: globalStub, DEFAULT_CONFIG: defaults, previousBridge: null,
    BRIDGE_VERSION: Number(source.match(/const BRIDGE_VERSION = (\d+)/)[1]), SQLITE_EXT_VERSION: Number(source.match(/const SQLITE_EXT_VERSION = (\d+)/)[1]),
    WINDOW_NAME_PREFIX: source.match(/const WINDOW_NAME_PREFIX = '([^']+)'/)[1],
    createJsonDeltaWorkerClient: () => null, ensureNeutralinoEnvironment() {}, TextEncoder, Map, Set, Date, Uint8Array, console,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); if (ms === 30000) timer.unref(); return timer; }, clearTimeout, performance, TextDecoder, atob, fetch, AbortController, ArrayBuffer, DataView, createStorageChunkCodec, createStorageChunkWorker, joinPath: (...p) => path.join(...p), sessionGet: () => null, sessionSet() {},
    syncHttpGetText: extra.syncGet || (() => null), window: extra.window,
  };
  const Bridge = vm.runInNewContext(`(${classText})`, context);
  const bridge = new Bridge({ chunkStorage: false, storageDir: dir, customFs: { readFile: p => fsp.readFile(p, 'utf8'), getStats: p => fsp.stat(p) },
    customSqliteStore: async (action, payload) => backend(path.join(dir, 'storage.sqlite'), action, payload) });
  Object.assign(bridge, { initDexieDatabase() {}, installProxy() { this.proxy = {}; }, setupContextMenu() {}, setupLifecycleHooks() {},
    showSavingBackdrop(...args) { bridge.messages.push(args); }, waitForBackdropPaint: async () => {}, showActionToast() {}, hideSavingBackdrop() {}, messages: [],
  });
  return { bridge, globalStub, context };
}
const hash = s => createHash('sha256').update(s).digest('hex');
async function fixture() {
  const dir = await fsp.mkdtemp(path.join(root, '.tmp/save-recovery/test-'));
  const values = { settings: 'old', 'tavern-game': JSON.stringify({ text: '한글😀'.repeat(20000) }), '__proto__': 'not-special' };
  const manifest = { __updatedAt__: 100, __revision__: 3, __external__: { 'tavern-game': 'blob_test.dat' }, data: { settings: values.settings } };
  await fsp.writeFile(path.join(dir, 'blob_test.dat'), values['tavern-game']);
  await fsp.writeFile(path.join(dir, 'storage.json'), JSON.stringify(manifest));
  return { dir, values, manifest };
}
async function test() {
  const launcher=fs.readFileSync(path.join(root, 'launcher.html'), 'utf8');
  assert(launcher.includes(source.trimEnd()), 'launcher fallback matches bridge');
  for (const match of launcher.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) new vm.Script(match[1]);
  for (const [key, file] of Object.entries({ csharpSource: 'NeuSqliteExtension.cs', pythonSource: 'main.py', cmdLauncher: 'run-extension.cmd', shLauncher: 'run-extension.sh' }))
    assert.equal(getSources()[key].replace(/\r\n/g, '\n').trimEnd(), fs.readFileSync(path.join(root, 'extensions/sqlite', file), 'utf8').replace(/\r\n/g, '\n').trimEnd(), key);
  const { dir, values, manifest } = await fixture();
  const { bridge: b, globalStub } = makeBridge(dir);
  await b.init();
  assert.equal(b.memory.get('tavern-game'), values['tavern-game']);
  const originalBlobHash = hash(await fsp.readFile(path.join(dir, 'blob_test.dat')));
  assert.equal(backend(path.join(dir, 'storage.sqlite'), 'exportAll').saveCommit.verified, true);
  console.log('PASS migration and reopened SHA-256 validation');

  const store = b.customSqliteStore;
  b.customSqliteStore = async (action, payload) => action === 'commitSave' ? { ok: false, error: 'injected write failure' } : store(action, payload);
  b._setInternal('settings', 'unsaved', false);
  await assert.rejects(b.flushAll(), /injected write failure/);
  assert(b.dirtySqliteKeys.has('settings'));
  assert.equal(await b.safeExitApplication(), false);
  assert.equal(globalStub.exitCount, 0);
  assert(!b.messages.some(m => m[2].mode === 'success'));
  console.log('PASS failed save retains dirty data and blocks successful exit');
  b.customSqliteStore = store;
  await b.flushAll();
  assert.equal(hash(await fsp.readFile(path.join(dir, 'blob_test.dat'))), originalBlobHash);
  assert(fs.existsSync(path.join(dir, 'storage.json')));
  console.log('PASS small-key saves preserve legacy blobs and manifest');

  const before = backend(path.join(dir, 'storage.sqlite'), 'exportAll');
  const wrong = await store('commitSave', { id: 'bad', baseId: before.saveCommit.id, revision: 9, updatedAt: 300,
    clearAll: true, kvDeletes: [], kvUpserts: [{ key: 'settings', valueText: 'partial' }], expectedHashes: before.saveCommit.hashes });
  assert.equal(wrong.ok, false);
  assert.deepEqual(backend(path.join(dir, 'storage.sqlite'), 'exportAll').data, before.data);
  assert.equal(backend(path.join(dir, 'storage.sqlite'), 'exportAll').saveCommit.id, before.saveCommit.id);
  console.log('PASS failed verification rolls back values and commit marker together');

  let signal, release;
  const arrived = new Promise(resolve => { signal = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let held = false;
  b.customSqliteStore = async (action, payload) => {
    if (action === 'commitSave' && !held) { held = true; signal(); await gate; }
    return store(action, payload);
  };
  b._setInternal('settings', 'first', false);
  const flushing = b.flushAll();
  await arrived;
  b._setInternal('settings', 'second', false);
  b._removeInternal('tavern-game', false);
  release();
  await flushing;
  let data = backend(path.join(dir, 'storage.sqlite'), 'exportAll').data;
  assert.equal(data.settings, 'second'); assert(!('tavern-game' in data));
  console.log('PASS changes and deletions during an active save reach the next commit');

  b.customSqliteStore = async (action, payload) => {
    const result = await store(action, payload);
    return action === 'commitSave' ? null : result;
  };
  b._setInternal('settings', 'reply-lost', false);
  await b.flushAll();
  assert.equal(b.dirtySqliteKeys.size, 0);
  console.log('PASS lost commit response is recovered by commit id');
  b.customSqliteStore = store;
  b._clearInternal(false);
  await b.flushAll();
  const empty = makeBridge(dir).bridge; await empty.init();
  assert.equal(empty.memory.size, 0);
  assert(fs.existsSync(path.join(dir, 'blob_test.dat')));
  console.log('PASS committed empty save does not resurrect retained legacy data');
  await fsp.unlink(path.join(dir, 'blob_test.dat'));
  const independent = makeBridge(dir).bridge; await independent.init();
  assert.equal(independent.memory.size, 0);
  console.log('PASS verified SQLite no longer depends on obsolete legacy blobs');

  const missing = await fixture();
  await fsp.unlink(path.join(missing.dir, 'blob_test.dat'));
  const broken = makeBridge(missing.dir).bridge;
  await assert.rejects(broken.init(), /ENOENT/);
  const missingState = backend(path.join(missing.dir, 'storage.sqlite'), 'exportAll');
  assert.equal(missingState.saveCommit, null);
  assert.equal(missingState.totalKeys, 0);
  console.log('PASS missing legacy blob blocks migration without committing an empty save');

  const boot = await fixture();
  const fakeWindow = { name: '', location: { pathname: '/game.html' } };
  const { bridge: sync, globalStub: syncGlobal } = makeBridge(boot.dir, { window: fakeWindow,
    syncGet: url => url.endsWith('storage.json') ? JSON.stringify(boot.manifest) : url.endsWith('blob_test.dat') ? boot.values['tavern-game'] :
      url.endsWith('sqlite-endpoint.json') ? '{"url":"http://test"}' : url.endsWith('export-meta') ? '{"ok":true,"saveCommit":null,"inlineData":{"tavern-game":"STALE"},"largeKeys":[]}' : null });
  syncGlobal.__IS_WAYWARD_LAUNCHER_UI__ = false;
  sync.restoreSnapshotFromWindowName = () => false;
  assert.equal(sync.bootstrapSyncIfPossible(), true);
  assert.equal(sync.memory.get('tavern-game'), boot.values['tavern-game']);
  await sync.init();
  assert.equal(sync.initialized, true);
  console.log('PASS stale SQLite bootstrap cannot bypass the newer legacy snapshot');

  const bootData = backend(path.join(boot.dir, 'storage.sqlite'), 'exportAll');
  const bootMeta = backend(path.join(boot.dir, 'storage.sqlite'), 'exportMeta');
  function verifiedBootstrap(invalidate) {
    let reads = 0;
    const pair = makeBridge(boot.dir, { window: fakeWindow, syncGet: url => {
      if (url.endsWith('storage.json')) return JSON.stringify(boot.manifest);
      if (url.endsWith('sqlite-endpoint.json')) return '{"url":"http://test"}';
      if (url.endsWith('export-meta')) {
        reads++;
        return JSON.stringify(invalidate && reads > 1 ? { ...bootMeta, saveCommit: { ...bootMeta.saveCommit, verified: false } } : bootMeta);
      }
      if (url.includes('get-raw?key=')) return bootData.data[decodeURIComponent(url.split('key=')[1].split('&')[0])];
      return null;
    } });
    pair.globalStub.__IS_WAYWARD_LAUNCHER_UI__ = false;
    pair.bridge.restoreSnapshotFromWindowName = () => false;
    return pair.bridge;
  }
  const verifiedBoot = verifiedBootstrap(false);
  assert.equal(verifiedBoot.bootstrapSyncIfPossible(), true);
  assert.equal(hash(verifiedBoot.memory.get('tavern-game') || ''), hash(boot.values['tavern-game']));
  console.log('PASS verified SQLite fully restores the synchronous game storage');
  const changingBoot = verifiedBootstrap(true);
  assert.equal(changingBoot.bootstrapSyncIfPossible(), false);
  assert.equal(changingBoot.memory.size, 0);
  assert(changingBoot._storageLoadError);
  console.log('PASS invalidation during bootstrap cannot publish a mixed snapshot');

  const timeout = makeBridge(dir).bridge;
  timeout.flushAll = () => new Promise(() => {});
  // Use the production deadline with an accelerated clock in this isolated context.
  const timeoutClass = vm.runInNewContext(`(${classText})`, { ...makeBridge(dir).context, setTimeout: (fn) => setTimeout(fn, 0) });
  Object.setPrototypeOf(timeout, timeoutClass.prototype);
  const result = await timeout.safeExitApplication();
  assert.equal(result, false);
  assert(!timeout.messages.some(m => m[2].mode === 'success'));
  console.log('PASS shutdown timeout is a failure and leaves the app open');
  assert.equal(await b.safeExitApplication(), true);
  assert.equal(globalStub.exitCount, 1);
  assert(b.messages.some(m => m[2].mode === 'success'));
  console.log('PASS successful exit follows a verified commit and daemon acknowledgement');
  console.log('ALL STORAGE RECOVERY TESTS PASSED');
}
async function migrate(dir) {
  const { bridge } = makeBridge(path.resolve(dir));
  await bridge.init();
  const exported = backend(path.join(dir, 'storage.sqlite'), 'exportAll');
  assert(exported.saveCommit.verified);
  console.log(JSON.stringify({ keys: exported.totalKeys, commitId: exported.saveCommit.id, verified: exported.saveCommit.verified, legacyImportedAt: exported.saveCommit.legacyUpdatedAt }));
}
if (require.main === module) (process.argv[2] === '--migrate' ? migrate(process.argv[3]) : test()).catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { makeBridge, backend };
