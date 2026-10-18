import hashlib
import json
import pathlib
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(dir=ROOT / ".tmp/save-recovery") as folder:
    process = subprocess.Popen([str(ROOT / "extensions/sqlite/neu-sqlite-ext.exe"), "--app-root", folder], creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        endpoint = pathlib.Path(folder) / "userdata/sqlite-endpoint.json"
        for _ in range(100):
            if endpoint.exists(): break
            if process.poll() is not None: raise RuntimeError("SQLite daemon exited during startup")
            time.sleep(0.05)
        url = json.loads(endpoint.read_text(encoding="utf-8-sig"))["url"]

        def rpc(action, payload):
            request = urllib.request.Request(url + "/rpc", data=json.dumps(dict(action=action, payload=payload), ensure_ascii=False).encode(), headers={"Content-Type": "text/plain;charset=UTF-8"})
            return json.load(urllib.request.urlopen(request, timeout=15))

        assert rpc("ping", {})["version"] == 22
        values = {"game": "한글😀" * 30000, "empty": ""}
        payload = dict(id="http-save-1", baseId="", revision=1, updatedAt=100, legacyUpdatedAt=90, clearAll=True, kvDeletes=[],
                       kvUpserts=[dict(key=k, valueText=v) for k, v in values.items()], expectedHashes={k: hashlib.sha256(v.encode()).hexdigest() for k, v in values.items()})
        committed = rpc("commitSave", payload)
        assert committed["ok"] and committed["commit"]["verified"]
        assert rpc("exportAll", {})["data"] == values
        assert urllib.request.urlopen(url + "/get-raw?key=game", timeout=15).read() == values["game"].encode()
        assert rpc("exportMeta", {})["saveCommit"]["id"] == "http-save-1"
        payload.update(id="http-save-2", baseId="http-save-1", expectedHashes={"game": "bad"})
        failed = rpc("commitSave", payload)
        assert failed["ok"] is False
        assert rpc("exportAll", {})["data"] == values
        assert rpc("shutdown", {"deleteBinary": False, "killParent": False})["ok"]
        process.wait(timeout=5)
        print("PASS real C# daemon HTTP startup, large UTF-8 commit, readback, rollback and graceful shutdown")
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
