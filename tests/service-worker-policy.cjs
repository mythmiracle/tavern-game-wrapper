const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../neutralino-storage-bridge.js'), 'utf8');
const helpers = source.slice(source.indexOf('  function isLocalNeutralinoUrl()'), source.indexOf('  function inferOsFromNavigator()'));

function fixture({ host = '127.0.0.1', app = true, configurable = true, own = false } = {}) {
  let registrations = 0;
  const serviceWorker = { register() { registrations++; return Promise.resolve({}); } };
  const prototype = { userAgent: 'test' };
  const navigator = Object.create(prototype);
  Object.defineProperty(own ? navigator : prototype, 'serviceWorker', { configurable, get: () => serviceWorker });
  function Worker() {}
  const global = { navigator, Worker, ...(app ? { NL_APPID: 'test.wrapper' } : {}) };
  const window = { location: { protocol: 'http:', hostname: host, port: '12345' } };
  const context = vm.createContext({ global, window, navigator });
  const disable = vm.runInContext(helpers + '\ndisableDesktopServiceWorkers;', context);
  return { global, navigator, context, disable, serviceWorker, Worker, count: () => registrations };
}

for (const own of [false, true]) {
  const f = fixture({ own });
  assert(f.disable());
  assert.equal('serviceWorker' in f.navigator, false);
  vm.runInContext('if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");', f.context);
  assert.equal(f.count(), 0, 'the game feature check must skip registration');
  assert.equal(f.global.Worker, f.Worker, 'dedicated saving Workers must remain available');
  assert.equal(f.navigator.userAgent, 'test');
  assert(f.disable(), 'repeated bootstrap must be safe');
}
console.log('PASS desktop game feature checks skip PWA registration while dedicated Workers remain available');

for (const options of [{ app: false }, { host: 'example.invalid' }]) {
  const f = fixture(options);
  assert.equal(f.disable(), false);
  assert.equal(f.navigator.serviceWorker, f.serviceWorker);
}
const protectedFeature = fixture({ configurable: false });
assert.equal(protectedFeature.disable(), false);
assert.equal(protectedFeature.navigator.serviceWorker, protectedFeature.serviceWorker);
console.log('PASS ordinary browsers and non-configurable browser features are left unchanged');
