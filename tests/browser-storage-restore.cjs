const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const restore = require('../browser-storage-restore.js');
const { makeBridge } = require('./storage-recovery.cjs');

class Storage {
  constructor(values = {}, limit = Infinity) { this.values = new Map(Object.entries(values)); this.limit = limit; this.writes = []; }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  removeItem(key) { this.values.delete(key); }
  setItem(key, value) {
    this.writes.push(key);
    const next = new Map(this.values).set(key, value);
    const size = [...next].reduce((total, [k, v]) => total + k.length + v.length, 0);
    if (size > this.limit) { const error = new Error('test quota'); error.name = 'QuotaExceededError'; throw error; }
    this.values = next;
  }
}

function test(name, body) { body(); console.log('PASS ' + name); }
function unchanged(storage, before) { assert.deepEqual([...storage.values].sort(), [...before].sort()); }

test('production launcher export round-trips raw packed slots, Unicode and empty strings', () => {
  const { bridge } = makeBridge(path.join(__dirname, '../.tmp/save-recovery'));
  const values = { 'tavern-game': '{"test":true}', 'tavern-slot-0': '\u0002wwlz1\u0000\ud800한글😀\ufeff', settings: '{"enabled":true}', empty: '' };
  bridge.memory = new Map(Object.entries(values));
  bridge._metadataOnly = false;
  const backup = '\ufeff' + JSON.stringify(bridge.exportDump());
  const storage = new Storage({ unrelated: 'keep' });
  const result = restore.restoreEntries(storage, restore.parseBackup(backup));
  assert.equal(result.count, 4);
  for (const [key, value] of Object.entries(values)) assert.equal(storage.getItem(key), value);
  assert.equal(storage.getItem('unrelated'), 'keep');
});

test('special object keys are data and malformed backups never write', () => {
  const data = restore.parseBackup('{"__proto__":"raw","constructor":"config"}');
  const storage = new Storage();
  restore.restoreEntries(storage, data);
  assert.equal(storage.getItem('__proto__'), 'raw');
  for (const bad of ['[]', 'null', '1', '{}', '{"key":{}}', '{"key":null}', '{"key":42}', 'invalid']) {
    assert.throws(() => restore.restoreEntries(storage, bad));
  }
  assert.equal(storage.writes.length, 2);
});

test('unchanged entries require no writes and shrinking entries free space before growth', () => {
  const storage = new Storage({ a: '1', b: 'longvalue' }, 12);
  restore.restoreEntries(storage, { a: 'longvalue', b: '1' });
  assert.deepEqual(storage.writes, ['b', 'a']);
  const count = storage.writes.length;
  assert.equal(restore.restoreEntries(storage, { a: 'longvalue', b: '1' }).changed, 0);
  assert.equal(storage.writes.length, count);
});

test('quota failure restores overwritten values, removes additions and preserves other keys', () => {
  const storage = new Storage({ a: 'old', unrelated: 'keep' }, 30);
  const before = new Map(storage.values);
  assert.throws(() => restore.restoreEntries(storage, { a: 'new', b: 'small', c: 'x'.repeat(40) }), error => {
    assert.equal(error.rollbackComplete, true);
    assert.match(error.message, /용량 제한/);
    return true;
  });
  unchanged(storage, before);
});

test('write-then-throw and silent write loss both roll back', () => {
  for (const fault of ['throw', 'drop']) {
    const storage = new Storage({ a: 'old' });
    const before = new Map(storage.values);
    const write = storage.setItem.bind(storage);
    storage.setItem = (key, value) => {
      if (value === 'new') {
        if (fault === 'throw') { write(key, value); throw new Error('injected post-write error'); }
        return;
      }
      write(key, value);
    };
    assert.throws(() => restore.restoreEntries(storage, { a: 'new' }), error => error.rollbackComplete === true);
    unchanged(storage, before);
  }
});

test('unavailable reads fail before writes and rollback failure is reported explicitly', () => {
  const unavailable = new Storage();
  unavailable.getItem = () => { throw new Error('blocked'); };
  assert.throws(() => restore.restoreEntries(unavailable, { key: 'value' }), /blocked/);
  assert.equal(unavailable.writes.length, 0);
  const broken = new Storage({ a: 'old' });
  broken.setItem = () => { throw new Error('storage unavailable'); };
  assert.throws(() => restore.restoreEntries(broken, { a: 'new' }), error => {
    assert.equal(error.rollbackComplete, false);
    assert.match(error.message, /되돌리지 못했습니다/);
    return true;
  });
});

// Exercise the copied command in a separate page realm with native storage
// methods and deliberately hostile game hooks. No actual browser data is used.
function pageFixture(mode = 'command') {
  const elements = new Map(), ids = new Map();
  class Element {
    constructor(tag) {
      this.tag = tag; this.style = {}; this.listeners = new Map(); this.children = []; this.files = [];
      this.classList = { add() {}, remove() {} };
    }
    set innerHTML(value) {
      this.children = [];
      for (const match of value.matchAll(/\bid="([^"]+)"/g)) { const child = new Element(match[1]); child.id = match[1]; ids.set(child.id, child); }
    }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    appendChild(child) { this.children.push(child); if (child.id) ids.set(child.id, child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren() { this.children = []; }
    remove() { this.removed = true; if (this.id) ids.delete(this.id); }
    attachShadow() { return { set innerHTML(value) {}, querySelector(selector) { if (!elements.has(selector)) elements.set(selector, new Element(selector)); return elements.get(selector); } }; }
    async fire(name) { return this.listeners.get(name)?.({ target: this }); }
  }
  const native = new Storage({ unrelated: 'keep' });
  const nativeMethods = {
    getItem(key) { return Storage.prototype.getItem.call(this, key); },
    setItem(key, value) { return Storage.prototype.setItem.call(this, key, value); },
    removeItem(key) { return Storage.prototype.removeItem.call(this, key); },
  };
  if (mode === 'command') native.getItem = native.setItem = () => { throw new Error('game compression hooks must not run'); };
  const frames = [], alerts = [];
  let reloaded = 0;
  const document = { body: new Element('body'), head: new Element('head'), getElementById: id => ids.get(id), createElement(tag) {
    const node = new Element(tag);
    if (tag === 'iframe') { node.contentWindow = { Storage: { prototype: nativeMethods } }; frames.push(node); }
    return node;
  } };
  const context = { document, localStorage: native, location: { href: 'file:///test-game.html', pathname: '/test-game.html', reload() { reloaded++; } },
    alert: text => alerts.push(text), confirm: () => true };
  if (mode === 'extractor') {
    const html = fs.readFileSync(path.join(__dirname, '../localstorage-extractor.html'), 'utf8');
    for (const match of html.matchAll(/\bid="([^"]+)"/g)) { const child = new Element(match[1]); child.id = match[1]; ids.set(child.id, child); }
    context.window = context;
    context.navigator = {};
    context.setTimeout = callback => { callback(); return 1; };
    context.requestAnimationFrame = callback => callback();
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../browser-storage-restore.js'), 'utf8'), context);
    for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) vm.runInNewContext(script[1], context);
  } else vm.runInNewContext(restore.consoleCommand(), context);
  return { context, elements, native, frames, alerts, reloaded: () => reloaded, find: name => mode === 'extractor' ? ids.get(name.replace(/^#/, '')) : elements.get(name) };
}

async function testPage() {
  const direct = pageFixture('extractor');
  assert.equal(direct.find('#btn-restore-storage').disabled, true);
  direct.find('#file-upload-input').files = [{ name: 'synthetic-backup.json', text: async () => JSON.stringify({ 'tavern-slot-0': '\u0002wwlz1\ud800한글', skip: 'not selected' }) }];
  await direct.find('#file-upload-input').fire('change');
  assert.equal(direct.native.writes.length, 0, 'opening a file must not modify storage');
  assert.equal(direct.find('#btn-restore-storage').disabled, false);
  const skipped = direct.find('#keys-table-body').children.find(row => row.children[1].textContent === 'skip').children[0].children[0];
  skipped.checked = false;
  await skipped.fire('change');
  await direct.find('#btn-restore-storage').fire('click');
  assert.equal(direct.native.getItem('tavern-slot-0'), '\u0002wwlz1\ud800한글');
  assert.equal(direct.native.getItem('skip'), null);
  assert.equal(direct.native.getItem('unrelated'), 'keep');
  assert.equal(direct.reloaded(), 0, 'the backup tool should stay open after direct restoration');
  assert.match(direct.find('#status-banner-text').textContent, /1개 항목.*로컬 저장소에 복원했습니다/);
  assert.equal(direct.find('#restore-result').hidden, false);
  assert.match(direct.find('#restore-result').textContent, /1개 항목 복원·검증 완료\n변경: 1개/);
  assert.equal(direct.frames[0].removed, true);
  await direct.find('#btn-restore-storage').fire('click');
  assert.match(direct.find('#restore-result').textContent, /변경: 0개 · 기존 값과 동일: 1개/);
  console.log('PASS extractor UI opens a backup without writes, restores only checked raw values and keeps its screen open');

  const directFailure = pageFixture('extractor');
  directFailure.native.limit = 1;
  const directBefore = new Map(directFailure.native.values);
  directFailure.find('#file-upload-input').files = [{ name: 'quota-test.json', text: async () => '{"save":"too large"}' }];
  await directFailure.find('#file-upload-input').fire('change');
  await directFailure.find('#btn-restore-storage').fire('click');
  unchanged(directFailure.native, directBefore);
  assert.match(directFailure.find('#status-banner-text').textContent, /용량 제한/);
  assert.equal(directFailure.find('#restore-result').hidden, false);
  assert.match(directFailure.find('#restore-result').textContent, /복원 실패\n.*용량 제한[\s\S]*원래 값으로 되돌렸습니다/);
  assert.equal(directFailure.find('#btn-restore-storage').disabled, false, 'a failed restore must allow retry');
  console.log('PASS extractor UI reports quota failure, restores previous values and permits retry');

  const directCancel = pageFixture('extractor');
  directCancel.context.confirm = () => false;
  directCancel.find('#file-upload-input').files = [{ name: 'cancel-test.json', text: async () => '{"save":"value"}' }];
  await directCancel.find('#file-upload-input').fire('change');
  await directCancel.find('#btn-restore-storage').fire('click');
  assert.equal(directCancel.native.writes.length, 0);
  assert.match(directCancel.find('#restore-result').textContent, /복원을 취소했습니다/);
  directCancel.find('#file-upload-input').files = [{ name: 'invalid.json', text: async () => '{"save":null}' }];
  await directCancel.find('#file-upload-input').fire('change');
  assert.equal(directCancel.find('#btn-restore-storage').disabled, true, 'an invalid new file must not restore the previous file');
  assert.equal(directCancel.find('#restore-result').hidden, true, 'opening a new file must clear the prior restore result');
  console.log('PASS extractor UI cancellation makes no writes and an invalid backup disables restoration');

  const insideApp = pageFixture('extractor');
  insideApp.context.NL_APPID = 'test.launcher';
  insideApp.find('#file-upload-input').files = [{ name: 'test.json', text: async () => '{"save":"value"}' }];
  await insideApp.find('#file-upload-input').fire('change');
  await insideApp.find('#btn-restore-storage').fire('click');
  assert.equal(insideApp.native.writes.length, 0);
  assert.match(insideApp.find('#status-banner-text').textContent, /브라우저에서 이 도구/);
  console.log('PASS extractor direct restoration rejects an embedded desktop app window');

  const page = pageFixture();
  page.find('#file').files = [{ text: async () => JSON.stringify({ 'tavern-slot-0': '\u0002wwlz1\ud800한글', skip: 'untouched' }) }];
  await page.find('#file').fire('change');
  const rows = page.find('#keys').children;
  rows[1].children[0].checked = false;
  await rows[1].children[0].fire('change');
  await page.find('#restore').fire('click');
  assert.equal(Storage.prototype.getItem.call(page.native, 'tavern-slot-0'), '\u0002wwlz1\ud800한글');
  assert.equal(Storage.prototype.getItem.call(page.native, 'skip'), null);
  assert.equal(Storage.prototype.getItem.call(page.native, 'unrelated'), 'keep');
  assert.equal(page.reloaded(), 1);
  assert.equal(page.frames.length, 1);
  assert.equal(page.frames[0].removed, true);
  console.log('PASS copied offline command selects keys, bypasses game compression hooks, verifies and reloads');

  const failed = pageFixture();
  failed.native.limit = 1;
  const before = new Map(failed.native.values);
  failed.find('#file').files = [{ text: async () => '{"key":"too large"}' }];
  await failed.find('#file').fire('change');
  await failed.find('#restore').fire('click');
  unchanged(failed.native, before);
  assert.equal(failed.reloaded(), 0);
  assert.match(failed.find('#status').textContent, /용량 제한/);
  console.log('PASS copied command displays quota failure without reloading or changing existing saves');

  const cancelled = pageFixture(); cancelled.context.confirm = () => false;
  cancelled.find('#file').files = [{ text: async () => '{"key":"value"}' }];
  await cancelled.find('#file').fire('change');
  await cancelled.find('#restore').fire('click');
  assert.equal(cancelled.frames.length, 0);
  assert.equal(cancelled.reloaded(), 0);
  console.log('PASS cancelling the restore confirmation makes no writes');

  const alerts = [];
  vm.runInNewContext(restore.consoleCommand(), { __storageBridge: {}, alert: text => alerts.push(text) });
  assert.equal(alerts.length, 1);
  console.log('PASS copied command rejects a desktop launcher tab');

  for (const name of ['launcher.html', 'localstorage-extractor.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
    assert.match(html, /src="browser-storage-restore\.js\?v=3"/);
    assert.match(html, /id="btn-copy-restore-command"/);
    assert.match(html, /BrowserStorageRestore\.consoleCommand\(\)/);
    assert(!html.includes('래퍼'));
    assert(!html.includes('btn-create-browser-game'));
    if (name === 'launcher.html') assert.match(html, /id="btn-open-restore-tool"/);
    else {
      assert.match(html, /id="btn-restore-storage"/);
      assert.match(html, /<details[\s\S]*id="btn-copy-restore-command"[\s\S]*<\/details>/);
    }
    for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) new vm.Script(script[1], { filename: name });
  }
  console.log('PASS launcher opens the restore tool and the extractor offers direct restoration with a command fallback');
}

testPage().catch(error => { console.error(error.stack); process.exitCode = 1; });
