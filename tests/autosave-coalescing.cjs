const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeBridge, backend } = require('./storage-recovery.cjs');

const root = path.join(__dirname, '../.tmp/autosave-coalescing');
fs.mkdirSync(root, { recursive: true });

function fixture(dir = root) {
  const pair = makeBridge(dir, { window: { name: '', location: { pathname: '/game.html' } } });
  const { bridge: b, context } = pair;
  let now = 1000, nextTimer = 0, serializations = 0, guardCalls = 0;
  const timers = new Map();
  context.Date = class extends Date { static now() { return now; } };
  context.setTimeout = (fn, ms) => { timers.set(++nextTimer, { fn, at: now + ms }); return nextTimer; };
  context.clearTimeout = id => timers.delete(id);
  b.scheduleDexieFlush = b.scheduleSqliteFlush = () => {};
  class Storage {
    getItem() { return null; } setItem() {} removeItem() {} clear() {} key() { return null; }
    get length() { return 0; }
  }
  const nativeStorageMethods = Object.fromEntries(['getItem', 'setItem', 'removeItem', 'clear', 'key'].map(name => [name, Storage.prototype[name]]));
  nativeStorageMethods.lengthDescriptor = Object.getOwnPropertyDescriptor(Storage.prototype, 'length');
  Object.assign(context, { Storage, nativeSessionStorage: null, nativeStorageMethods });
  Object.getPrototypeOf(b).installProxy.call(b);
  let state = { state: { counter: 0, text: 'synthetic'.repeat(1000) }, started: true, undoStack: ['not persisted'] };
  const jsonStorage = {
    getItem(name) { const text = b.proxy.getItem(name); return text === null ? null : JSON.parse(text); },
    setItem(name, value) { serializations++; return b.proxy.setItem(name, JSON.stringify(value)); },
    removeItem(name) { return b.proxy.removeItem(name); },
  };
  const guarded = { ...jsonStorage, __saveCompress: true,
    setItem(...args) { guardCalls++; return jsonStorage.setItem(...args); },
  };
  let options = { name: 'tavern-game', version: 9, partialize: s => ({ state: s.state, started: s.started, undoStack: [] }), storage: guarded };
  const store = Object.assign(function boundStore() {}, {
    getState: () => state,
    setState(next) {
      state = { ...state, ...next };
      return options.storage.setItem(options.name, { state: options.partialize({ ...state }), version: options.version });
    },
    persist: { getOptions: () => options, setOptions(next) { options = { ...options, ...next }; } },
  });
  const engine = { unrelated: {}, store };
  Object.defineProperty(engine, 'throwingBinding', { enumerable: true, get() { throw new Error('unavailable binding'); } });
  return { ...pair, store, engine, Storage, guarded, timers,
    install() { return b.attachGameAutosave(engine); },
    counts: () => ({ serializations, guardCalls }),
    update(counter, extra = {}) { store.setState({ state: { ...state.state, counter, ...extra } }); },
    expected: () => JSON.stringify({ state: options.partialize({ ...state }), version: options.version }),
    advance(ms) {
      const end = now + ms;
      for (let loops = 0; loops < 1000; loops++) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, z) => a[1].at - z[1].at)[0];
        if (!due) { now = end; return; }
        timers.delete(due[0]); now = due[1].at; due[1].fn();
      }
      throw new Error('Timer loop');
    },
  };
}

async function test() {
  const f = fixture(); assert.equal(f.install(), true); assert.equal(f.install(), true);
  assert.equal(f.store.persist.getOptions().storage.__saveCompress, true);
  for (let i = 1; i <= 10; i++) f.update(i);
  assert.equal(f.counts().serializations, 0);
  assert.equal(f.bridge.hasUnsavedChanges(), true);
  assert(f.bridge.storageKeys().includes('tavern-game'));
  assert.equal(f.bridge.proxy.length, 1, 'key enumeration must not force serialization');
  f.advance(249); assert.equal(f.counts().serializations, 0);
  f.advance(1); assert.equal(f.counts().serializations, 1); assert.equal(f.counts().guardCalls, 1);
  assert.equal(f.bridge.memory.get('tavern-game'), f.expected());
  assert.equal(f.bridge.getStats().autosaveMetrics.mergedRequests, 9);
  console.log('PASS ten state updates serialize only the latest state once and retain the existing mod storage guard');

  const continuous = fixture(); continuous.install();
  for (let i = 0; i < 5; i++) { continuous.update(i); continuous.advance(200); }
  assert.equal(continuous.counts().serializations, 1);
  assert.equal(JSON.parse(continuous.bridge.memory.get('tavern-game')).state.state.counter, 4);
  console.log('PASS continuous updates cannot postpone JSON serialization beyond one second');

  for (const boundary of ['read', 'hydrate', 'manual-write', 'manual-read', 'export', 'carrier']) {
    const p = fixture(); p.install(); p.update(42);
    if (boundary === 'read') assert.equal(p.bridge.proxy.getItem('tavern-game'), p.expected());
    if (boundary === 'hydrate') assert.equal(p.store.persist.getOptions().storage.getItem('tavern-game').state.state.counter, 42);
    if (boundary === 'manual-write') {
      const rawSet = p.Storage.prototype.setItem;
      p.Storage.prototype.setItem = function (key, value) {
        return rawSet.call(this, key, key.startsWith('tavern-slot-') ? 'test-packed:' + value : value);
      };
      p.bridge.proxy.setItem('tavern-slot-0', 'manual-data');
      assert.equal(p.bridge.memory.get('tavern-slot-0'), 'test-packed:manual-data');
    }
    if (boundary === 'manual-read') p.bridge.proxy.getItem('tavern-slot-0');
    if (boundary === 'export') assert.equal(p.bridge.exportDump()['tavern-game'], p.expected());
    if (boundary === 'carrier') p.bridge.saveSnapshotToWindowName();
    assert.equal(p.counts().serializations, 1, boundary);
    assert.equal(p.bridge.memory.get('tavern-game'), p.expected());
    p.advance(2000); assert.equal(p.counts().serializations, 1, boundary + ': no duplicate delayed write');
  }
  console.log('PASS raw reads, hydration, manual slots, backup export and navigation drain pending autosaves before use');

  for (const operation of ['remove', 'clear', 'raw-overwrite']) {
    const p = fixture(); p.install(); p.update(7);
    if (operation === 'remove') p.bridge.proxy.removeItem('tavern-game');
    if (operation === 'clear') p.bridge.proxy.clear();
    if (operation === 'raw-overwrite') p.bridge.proxy.setItem('tavern-game', 'imported-raw-value');
    p.advance(2000);
    assert.equal(p.counts().serializations, 0);
    assert.equal(p.bridge.proxy.getItem('tavern-game'), operation === 'raw-overwrite' ? 'imported-raw-value' : null);
  }
  console.log('PASS delete, clear and explicit replacement cancel queued autosaves without resurrecting older state');

  const mutable = fixture(); mutable.install(); mutable.update(1);
  mutable.store.getState().state.counter = 2;
  mutable.advance(250);
  assert.equal(JSON.parse(mutable.bridge.memory.get('tavern-game')).state.state.counter, 2);
  console.log('PASS autosave samples current state at flush without assuming that mod objects are immutable');

  const failed = fixture(); failed.install(); failed.update(1);
  const write = failed.bridge._setInternal;
  failed.bridge._setInternal = () => { throw new Error('injected serializer/write failure'); };
  failed.advance(250);
  assert.equal(failed.bridge._gameAutosave.pending, true);
  assert.match(failed.bridge.lastSaveError, /injected/);
  assert.equal(await failed.bridge.safeExitApplication(), false);
  assert.equal(failed.globalStub.exitCount, 0);
  failed.bridge._setInternal = write;
  failed.bridge.flushPendingGameAutosave();
  assert.equal(failed.bridge._gameAutosave.pending, false);
  assert.equal(failed.bridge._gameAutosaveError, null);
  assert.equal(failed.bridge.memory.get('tavern-game'), failed.expected());
  console.log('PASS a failed delayed write remains pending, prevents exit and can be retried');

  const asyncStorage = fixture();
  asyncStorage.guarded.setItem = async () => {};
  assert.equal(asyncStorage.install(), false, 'known asynchronous storage must keep its original path');
  const unexpectedAsync = fixture(); unexpectedAsync.guarded.setItem = () => Promise.resolve(); unexpectedAsync.install();
  unexpectedAsync.update(1); unexpectedAsync.advance(250);
  assert(unexpectedAsync.bridge._storageLoadError);
  assert.equal(await unexpectedAsync.bridge.safeExitApplication(), false);
  assert.equal(unexpectedAsync.globalStub.exitCount, 0);
  console.log('PASS asynchronous storage is excluded or fails closed instead of reporting an unconfirmed save');

  const reentrant = fixture(); reentrant.install();
  const oldWrite = reentrant.bridge._setInternal;
  let changed = false;
  reentrant.bridge._setInternal = function (...args) {
    const result = oldWrite.apply(this, args);
    if (!changed) { changed = true; reentrant.update(2); }
    return result;
  };
  reentrant.update(1); reentrant.advance(250);
  assert.equal(reentrant.bridge._gameAutosave.pending, true);
  reentrant.advance(250);
  assert.equal(reentrant.counts().serializations, 2);
  assert.equal(reentrant.bridge.memory.get('tavern-game'), reentrant.expected());
  console.log('PASS a new request arriving during serialization survives for the next batch');

  const hooked = fixture(); let rendered = 0;
  const bootstrap = 'globalThis.__WML__.boot({game:"test",engine:__wmlE,render:__wmlRender});';
  const patched = hooked.bridge.rewriteGameAutosaveBootstrap(bootstrap);
  await vm.runInNewContext(patched, {
    __wmlE: hooked.engine, __wmlRender: () => { rendered++; }, __storageBridge: hooked.bridge,
    __WML__: Object.freeze({ async boot({ render }) { await Promise.resolve(); render(); } }),
  });
  hooked.update(1); assert.equal(hooked.counts().serializations, 0);
  hooked.advance(250); assert.equal(hooked.counts().serializations, 1); assert.equal(rendered, 1);
  for (const unknown of ['<html>other game</html>', bootstrap + bootstrap]) assert.equal(hooked.bridge.rewriteGameAutosaveBootstrap(unknown), unknown);
  const disabled = fixture(); disabled.bridge.config.coalesceGameAutosave = false;
  assert.equal(disabled.install(), false); disabled.update(1); assert.equal(disabled.counts().serializations, 1);
  assert.equal(disabled.bridge.rewriteGameAutosaveBootstrap(bootstrap), bootstrap);
  console.log('PASS execution-copy hook attaches after mod setup, preserves frozen WML APIs and leaves unknown or disabled bundles unchanged');

  for (const chunkStorage of [false, true]) {
  const dir = fs.mkdtempSync(path.join(root, 'sqlite-'));
  const saved = fixture(dir); saved.bridge.config.chunkStorage = chunkStorage;
  await saved.bridge.init(); saved.install(); saved.update(99, { text: 'synthetic'.repeat(10000) });
  await saved.bridge.flushAll();
  assert.equal(saved.counts().serializations, 1);
  assert.equal(backend(path.join(dir, 'storage.sqlite'), 'exportAll').data['tavern-game'], saved.expected());
  const reopened = makeBridge(dir).bridge; reopened.config.chunkStorage = chunkStorage;
  await reopened.init(); await reopened.ensureDataLoaded();
  assert.equal(reopened.memory.get('tavern-game'), saved.expected());
  saved.update(100); await saved.bridge.importDump({ 'tavern-game': 'replacement-from-backup' }, true);
  saved.update(101);
  saved.advance(2000);
  assert.equal(backend(path.join(dir, 'storage.sqlite'), 'exportAll').data['tavern-game'], 'replacement-from-backup');
  const continued = fixture(dir); continued.bridge.config.chunkStorage = chunkStorage;
  await continued.bridge.init(); continued.install(); continued.update(101);
  assert.equal(await continued.bridge.safeExitApplication(), true);
  assert.equal(continued.globalStub.exitCount, 1);
  assert.equal(backend(path.join(dir, 'storage.sqlite'), 'exportAll').data['tavern-game'], continued.expected());
  }
  console.log('PASS flush, reopen, backup import and exit preserve the last autosave through real SQLite raw and chunk commits');

  if (process.argv.includes('--benchmark')) {
    const measure = coalesce => {
      const p = fixture(); const payload = 'x'.repeat(24 * 1024 * 1024);
      if (coalesce) p.install();
      const start = performance.now();
      for (let i = 1; i <= 10; i++) p.update(i, { text: payload });
      p.bridge.flushPendingGameAutosave();
      return { ms: performance.now() - start, serializations: p.counts().serializations, chars: p.bridge.memory.get('tavern-game').length };
    };
    const result = { synthetic: true, requests: 10, payloadMiB: 24, baseline: measure(false), coalesced: measure(true) };
    assert.equal(result.baseline.serializations, 10); assert.equal(result.coalesced.serializations, 1);
    assert.equal(result.baseline.chars, result.coalesced.chars);
    fs.writeFileSync(path.join(root, 'benchmark.json'), JSON.stringify(result, null, 2));
    console.log('BENCHMARK ' + JSON.stringify(result));
  }
}

if (require.main === module) test().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { fixture };
