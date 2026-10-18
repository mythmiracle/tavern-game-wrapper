// Self-contained factory for the restore command used in an offline game tab.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BrowserStorageRestore = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createBrowserStorageRestore() {
  'use strict';

  function parseBackup(input) {
    const data = typeof input === 'string' ? JSON.parse(input.replace(/^\uFEFF/, '').trim()) : input;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('키와 문자열 값으로 구성된 JSON 백업 파일을 선택해 주세요.');
    }
    const entries = Object.entries(data);
    if (!entries.length) throw new Error('백업 파일에 복원할 항목이 없습니다.');
    if (entries.some(([, value]) => typeof value !== 'string')) {
      throw new Error('문자열이 아닌 값이 있습니다. 실행기의 「현재 세이브 백업 저장」으로 만든 파일을 선택해 주세요.');
    }
    return Object.assign(Object.create(null), data);
  }

  // Keep this synchronous: game timers in this tab must not save between writes,
  // verification and rollback. Only keys included in the backup are affected.
  function restoreEntries(storage, input) {
    const entries = Object.entries(parseBackup(input));
    const previous = new Map(entries.map(([key]) => [key, storage.getItem(key)]));
    const changed = entries.filter(([key, value]) => previous.get(key) !== value);
    const growth = ([key, value]) => value.length - (previous.get(key) === null ? -key.length : previous.get(key).length);
    changed.sort((a, b) => growth(a) - growth(b));
    const attempted = [];
    try {
      for (const [key, value] of changed) {
        attempted.push(key);
        storage.setItem(key, value);
      }
      for (const [key, value] of entries) {
        if (storage.getItem(key) !== value) throw new Error('저장한 값을 다시 읽은 결과가 백업과 일치하지 않습니다.');
      }
    } catch (cause) {
      // Release the space used by this attempt before restoring larger old values.
      for (const key of attempted) {
        try { storage.removeItem(key); } catch (_) {}
      }
      for (const key of attempted) {
        if (previous.get(key) !== null) {
          try { storage.setItem(key, previous.get(key)); } catch (_) {}
        }
      }
      const rollbackComplete = attempted.every(key => {
        try { return storage.getItem(key) === previous.get(key); } catch (_) { return false; }
      });
      const quota = cause && (cause.name === 'QuotaExceededError' || cause.code === 22);
      const error = new Error((quota
        ? '브라우저 localStorage 용량 제한을 초과했습니다. 복원할 슬롯이나 항목을 줄여 주세요.'
        : '복원에 실패했습니다. ' + (cause && cause.message || String(cause))) + '\n' + (rollbackComplete
        ? '이번 복원으로 변경한 항목은 모두 원래 값으로 되돌렸습니다.'
        : '일부 항목을 원래 값으로 되돌리지 못했습니다. 게임을 진행하지 말고 보관한 백업으로 복원해 주세요.'));
      error.cause = cause;
      error.rollbackComplete = rollbackComplete;
      throw error;
    }
    return { count: entries.length, changed: changed.length, overwritten: changed.filter(([key]) => previous.get(key) !== null).length };
  }

  function nativeStorageAccess() {
    // WML hooks decompress getItem() results and may compress setItem() arguments.
    // A fresh same-origin realm supplies native methods for lossless raw-string I/O.
    const frame = document.createElement('iframe');
    frame.hidden = true;
    document.body.appendChild(frame);
    try {
      const storage = globalThis.localStorage;
      const proto = frame.contentWindow.Storage.prototype;
      return {
        getItem: key => proto.getItem.call(storage, key),
        setItem: (key, value) => proto.setItem.call(storage, key, value),
        removeItem: key => proto.removeItem.call(storage, key),
        dispose: () => frame.remove(),
      };
    } catch (error) {
      frame.remove();
      throw error;
    }
  }

  function open() {
    if (globalThis.__storageBridge || globalThis.NL_APPID) {
      alert('이 복원 기능은 실행기 밖에서 사용합니다. 브라우저의 원본 게임 탭에서 복원 명령을 실행해 주세요.');
      return;
    }
    const id = '__wayward_browser_restore__';
    const previous = document.getElementById(id);
    if (previous) previous.remove();
    const host = document.createElement('div');
    host.id = id;
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:#020617dd;padding:20px;box-sizing:border-box;';
    const panel = host.attachShadow({ mode: 'closed' });
    panel.innerHTML = `
      <style>
        :host{font:14px/1.6 system-ui,sans-serif;color:#e2e8f0} *{box-sizing:border-box}
        section{width:min(600px,90vw);max-height:90vh;overflow:auto;background:#0f172a;border:1px solid #334155;border-radius:18px;padding:24px}
        h2{margin:0 0 12px;font-size:20px} p{margin:10px 0} small{color:#94a3b8} input[type=file]{width:100%;margin:12px 0}
        #target{overflow-wrap:anywhere;color:#93c5fd} #keys{max-height:220px;overflow:auto;margin:12px 0}
        label{display:flex;gap:8px;align-items:baseline;overflow-wrap:anywhere;padding:3px 0} label span{flex:1}
        button{cursor:pointer;border:1px solid #475569;border-radius:8px;background:#1e293b;color:#e2e8f0;padding:9px 12px;font:inherit}
        #restore{background:#047857;border-color:#10b981} button:disabled{opacity:.4;cursor:default}
        #status{white-space:pre-wrap} footer{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
      </style>
      <section role="dialog" aria-modal="true" aria-labelledby="title">
        <h2 id="title">브라우저 세이브 복원</h2>
        <div id="target"></div>
        <p>같은 게임을 연 다른 탭은 닫고, 기존 브라우저 세이브도 먼저 백업해 두세요.</p>
        <label for="file">실행기에서 내보낸 세이브 백업 파일 선택</label>
        <input id="file" type="file" accept=".json,.txt,application/json,text/plain">
        <div><button id="all" type="button">전체 선택</button> <button id="none" type="button">선택 해제</button></div>
        <div id="keys"></div>
        <p id="status" role="status">JSON 파일을 선택하면 복원할 항목을 확인할 수 있습니다.</p>
        <small>선택한 항목만 덮어씁니다. 용량 제한으로 실패하면 변경한 항목을 되돌립니다. 성공하면 게임을 새로고침합니다.</small>
        <footer><button id="close" type="button">취소</button><button id="restore" type="button" disabled>선택한 항목 복원</button></footer>
      </section>`;
    const find = selector => panel.querySelector(selector);
    find('#target').textContent = '복원 대상: ' + location.href;
    document.body.appendChild(host);
    let data = Object.create(null);
    const selected = new Set();
    let readId = 0;
    function summary() {
      let chars = 0;
      for (const key of selected) chars += key.length + data[key].length;
      find('#status').textContent = `${selected.size}개 선택 · 문자열 크기 약 ${(chars * 2 / 1024 / 1024).toFixed(2)} MiB (UTF-16 기준)`;
      find('#restore').disabled = !selected.size;
    }
    function render() {
      find('#keys').replaceChildren();
      for (const [key, value] of Object.entries(data)) {
        const row = document.createElement('label');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = selected.has(key);
        check.addEventListener('change', () => { if (check.checked) selected.add(key); else selected.delete(key); summary(); });
        const name = document.createElement('span');
        name.textContent = key;
        const size = document.createElement('small');
        size.textContent = (value.length * 2 / 1024).toFixed(1) + ' KiB';
        row.append(check, name, size);
        find('#keys').appendChild(row);
      }
      summary();
    }
    find('#file').addEventListener('change', async event => {
      const currentRead = ++readId;
      selected.clear(); data = Object.create(null); render();
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      find('#status').textContent = '백업 파일을 읽고 있습니다…';
      try {
        const text = await file.text();
        if (currentRead !== readId) return;
        data = parseBackup(text);
        for (const key of Object.keys(data)) selected.add(key);
        render();
      } catch (error) {
        if (currentRead === readId) find('#status').textContent = '파일 읽기 실패: ' + error.message;
      }
    });
    find('#all').addEventListener('click', () => { for (const key of Object.keys(data)) selected.add(key); render(); });
    find('#none').addEventListener('click', () => { selected.clear(); render(); });
    find('#close').addEventListener('click', () => host.remove());
    find('#restore').addEventListener('click', () => {
      if (!selected.size || !confirm(`선택한 ${selected.size}개 항목을 이 게임의 localStorage에 복원할까요? 같은 키의 기존 값은 덮어씁니다.`)) return;
      let storage;
      try {
        storage = nativeStorageAccess();
        const values = Object.create(null);
        for (const key of selected) values[key] = data[key];
        const result = restoreEntries(storage, values);
        storage.dispose(); storage = null;
        // Reload in this same task, before game timers or cached mod hooks can save.
        alert(`${result.count}개 항목을 복원하고 다시 읽어 확인했습니다. 게임을 새로고침합니다.`);
        location.reload();
      } catch (error) {
        find('#status').textContent = error.message;
      } finally {
        if (storage) storage.dispose();
      }
    });
  }

  return { parseBackup, restoreEntries, nativeStorageAccess, open,
    consoleCommand: () => `(${createBrowserStorageRestore.toString()})().open();` };
});
