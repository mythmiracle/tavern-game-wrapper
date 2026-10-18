const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeBridge } = require('./storage-recovery.cjs');

const source = fs.readFileSync(path.join(__dirname, '../neutralino-storage-bridge.js'), 'utf8');
const factory = source.slice(source.indexOf('  function createMinimalNeutralinoRpcClient()'), source.indexOf('  class NeutralinoStorageBridge {')).trim();

class NativeEvent extends Event {
  constructor(type, options = {}) { super(type, { cancelable: true }); this.detail = options.detail; }
}

function fixture() {
  const sockets = [], sent = [], order = [];
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = Socket.CONNECTING; this.handlers = new Map(); sockets.push(this); }
    addEventListener(type, handler) { if (!this.handlers.has(type)) this.handlers.set(type, []); this.handlers.get(type).push(handler); }
    emit(type, event = {}) { for (const handler of this.handlers.get(type) || []) handler(event); }
    open() { this.readyState = Socket.OPEN; this.emit('open'); }
    close() { this.readyState = Socket.CLOSED; this.emit('close'); }
    nativeEvent(event) { this.emit('message', { data: JSON.stringify({ event, data: {} }) }); }
    send(text) {
      const request = JSON.parse(text); sent.push(request.method); order.push(request.method);
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: request.id, data: { returnValue: true } }) }));
    }
  }
  const window = new EventTarget();
  window.location = { hostname: '127.0.0.1', port: '12345', pathname: '/game.html' };
  const pair = makeBridge(path.join(__dirname, '../.tmp/save-recovery'), { window });
  Object.assign(pair.globalStub, { NL_PORT: 12345, NL_TOKEN: 'test-access.test-connect' });
  Object.assign(pair.context, { WebSocket: Socket, CustomEvent: NativeEvent, nativeSessionStorage: null,
    syncLexicalGlobalsToWindow() {}, parseNeutralinoGlobalsFromSource() { return false; }, isLocalNeutralinoUrl() { return true; } });
  const client = vm.runInNewContext(`(${factory})()`, pair.context);
  pair.globalStub.Neutralino = client;
  const bridge = pair.bridge;
  bridge.initialized = true;
  bridge.flushAll = async () => { order.push('commit'); return { ok: true }; };
  bridge.shutdownSqliteExtension = async () => { order.push('shutdown'); };
  const exit = bridge.safeExitApplication.bind(bridge);
  let closeCalls = 0, completion;
  bridge.safeExitApplication = () => { closeCalls++; completion = exit(); return completion; };
  return { ...pair, window, client, sockets, sent, order, install() { Object.getPrototypeOf(bridge).setupLifecycleHooks.call(bridge); },
    calls: () => closeCalls, completion: () => completion };
}

async function test() {
  const f = fixture();
  assert.equal(f.sockets.length, 0, 'creating the client must remain lazy');
  f.install();
  assert.equal(f.sockets.length, 1, 'close subscriptions must initialize the native connection');
  f.install(); f.client.init();
  assert.equal(f.sockets.length, 1, 'initialization and hooks must be idempotent');
  f.sockets[0].open();
  f.sockets[0].nativeEvent('windowClose');
  assert.equal(await f.completion(), true);
  assert.equal(f.calls(), 1, 'the transport and DOM dispatch must not invoke the close handler twice');
  assert.deepEqual(f.order, ['commit', 'shutdown', 'app.exit']);
  console.log('PASS native windowClose opens its event connection and exits once after commit and daemon shutdown');

  const failed = fixture(); failed.install(); failed.sockets[0].open();
  failed.bridge.flushAll = async () => { throw new Error('injected write failure'); };
  failed.sockets[0].nativeEvent('windowClose');
  assert.equal(await failed.completion(), false);
  assert.equal(failed.sent.length, 0); assert.equal(failed.order.length, 0); assert.equal(failed.bridge.isClosing, false);
  failed.bridge.flushAll = async () => { failed.order.push('commit'); return { ok: true }; };
  failed.sockets[0].nativeEvent('windowClose');
  assert.equal(await failed.completion(), true);
  assert.deepEqual(failed.order, ['commit', 'shutdown', 'app.exit']);
  console.log('PASS failed close keeps the window open and a later native close can retry successfully');

  const official = fixture();
  official.window.location.pathname = '/launcher.html';
  let initializations = 0;
  official.globalStub.Neutralino = {
    events: { on(name, handler) { official.window.addEventListener(name, handler); return Promise.resolve(); } },
    init() { initializations++; },
    app: { async exit() { official.order.push('app.exit'); } },
  };
  official.install(); official.install();
  official.window.dispatchEvent(new NativeEvent('windowClose'));
  assert.equal(await official.completion(), true);
  assert.equal(initializations, 1); assert.equal(official.calls(), 1);
  assert.deepEqual(official.order, ['commit', 'shutdown', 'app.exit']);
  console.log('PASS launcher close with the official client event interface initializes once and exits once');

  const dropped = fixture(); dropped.install(); dropped.sockets[0].close(); dropped.client.init(); dropped.client.init();
  assert.equal(dropped.sockets.length, 1, 'rejected handshakes must retain the reconnect circuit breaker');
  console.log('PASS the native event connection preserves handshake rejection protection');
}

test().catch(error => { console.error(error.stack); process.exitCode = 1; });
