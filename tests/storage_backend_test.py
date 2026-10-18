import hashlib
import importlib.util
import pathlib
import tempfile
import unittest
import base64
import copy
import json
import struct

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("storage_backend", ROOT / "extensions/sqlite/main.py")
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class StorageBackendTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / ".tmp/save-recovery")
        self.path = pathlib.Path(self.temp.name) / "storage.sqlite"
        self.store = backend.SqliteDeltaStore(str(self.path))

    def tearDown(self):
        self.store.shutdown()
        self.temp.cleanup()

    def commit(self, values, base_id="", **overrides):
        batch = dict(id="save-1", baseId=base_id, revision=1, updatedAt=100, legacyUpdatedAt=90,
                     clearAll=True, kvDeletes=[], kvUpserts=[dict(key=k, valueText=v) for k, v in values.items()],
                     expectedHashes={k: hashlib.sha256(v.encode()).hexdigest() for k, v in values.items()})
        batch.update(overrides)
        return self.store.commit_save(batch)

    def test_reopen_unicode_empty_and_large_values(self):
        values = {"game": "한글😀" * 50000, "empty": "", "__proto__": "value"}
        self.commit(values)
        self.store.shutdown()
        self.store = backend.SqliteDeltaStore(str(self.path))
        exported = self.store.export_all()
        self.assertEqual(exported["data"], values)
        self.assertTrue(exported["saveCommit"]["verified"])

    def test_failed_manifest_rolls_back_values_and_marker(self):
        self.commit({"game": "original"})
        with self.assertRaisesRegex(ValueError, "verification failed"):
            self.commit({"game": "partial"}, "save-1", id="save-2", expectedHashes={"game": "wrong"})
        self.assertEqual(self.store.export_all()["data"], {"game": "original"})
        self.assertEqual(self.store.get_save_commit()["id"], "save-1")

    def test_stale_writer_cannot_replace_committed_save(self):
        self.commit({"game": "original"})
        with self.assertRaisesRegex(ValueError, "conflict"):
            self.commit({"game": "stale"}, "wrong", id="save-2")
        self.assertEqual(self.store.export_all()["data"]["game"], "original")

    def test_empty_committed_save_retains_migration_marker(self):
        self.commit({"game": "original"})
        self.commit({}, "save-1", id="save-2")
        self.store.shutdown()
        self.store = backend.SqliteDeltaStore(str(self.path))
        exported = self.store.export_all()
        self.assertEqual(exported["data"], {})
        self.assertEqual(exported["saveCommit"]["legacyUpdatedAt"], 90)
        self.assertTrue(exported["saveCommit"]["verified"])

    def test_corruption_invalidates_marker(self):
        self.commit({"game": "original"})
        with self.store.conn:
            self.store.conn.execute("UPDATE kv_store SET value_text = 'changed'")
        self.assertFalse(self.store.export_meta()["saveCommit"]["verified"])

    def stage_chunk(self, vector, save_id, base_id="", send=True):
        manifest = vector['manifest']
        payload = dict(id=save_id, baseId=base_id, revision=1, updatedAt=100, legacyUpdatedAt=90,
                       entries={'game': manifest['root']}, manifests=[manifest])
        payload['rootHash'] = self.store._snapshot_hash(payload)
        result = self.store.prepare_chunk_save(payload)
        if send:
            for sha in result['missing']:
                data = base64.b64decode(vector['chunks'][sha])
                body = struct.pack('<I', 1) + bytes.fromhex(sha) + struct.pack('<I', len(data)) + data
                self.store.put_chunk_batch(save_id, body)
        return result

    def test_chunk_shared_vectors_and_reopen(self):
        vectors = json.loads((ROOT / '.tmp/chunk-storage/vectors.json').read_text(encoding='utf-8'))
        prior = ''
        for i, vector in enumerate(vectors):
            save_id = 'vector-' + str(i)
            self.stage_chunk(vector, save_id, prior)
            self.store.commit_chunk_save(save_id)
            self.assertEqual(self.store.export_all()['data']['game'], vector['value'])
            self.store.shutdown()
            self.store = backend.SqliteDeltaStore(str(self.path))
            self.assertEqual(self.store.export_all()['data']['game'], vector['value'])
            prior = save_id

    def test_chunk_missing_content_and_wrong_length_cannot_activate(self):
        vectors = json.loads((ROOT / '.tmp/chunk-storage/vectors.json').read_text(encoding='utf-8'))
        original = vectors[2]
        self.stage_chunk(original, 'pending', send=False)
        with self.assertRaisesRegex(ValueError, 'Missing chunk'): self.store.commit_chunk_save('pending')
        self.assertFalse(self.store.has_chunk_save())
        self.stage_chunk(original, 'pending')
        self.store.commit_chunk_save('pending')
        wrong = copy.deepcopy(original)
        wrong['manifest']['chars'] += 1
        m = wrong['manifest']
        canonical = '22\n%s\n%d\n%d\n' % (m['encoding'],m['chars'],m['bytes']) + ''.join('%s:%d\n' % (c['hash'],c['bytes']) for c in m['chunks'])
        m['root'] = hashlib.sha256(canonical.encode()).hexdigest()
        self.stage_chunk(wrong,'wrong','pending')
        with self.assertRaisesRegex(ValueError,'Character length'): self.store.commit_chunk_save('wrong')
        self.assertEqual(self.store.get_save_commit()['id'],'pending')

    def test_chunk_corruption_is_detected_after_restart(self):
        vector = json.loads((ROOT / '.tmp/chunk-storage/vectors.json').read_text(encoding='utf-8'))[2]
        self.stage_chunk(vector,'first'); self.store.commit_chunk_save('first')
        with self.store.conn: self.store.conn.execute("UPDATE chunk_blobs SET data = zeroblob(length(data))")
        self.store.shutdown(); self.store = backend.SqliteDeltaStore(str(self.path))
        with self.assertRaisesRegex(ValueError,'SHA-256'): self.store.export_all()

    def test_chunk_rollback_to_legacy_preserves_latest(self):
        vector = json.loads((ROOT / '.tmp/chunk-storage/vectors.json').read_text(encoding='utf-8'))[2]
        self.stage_chunk(vector,'first'); self.store.commit_chunk_save('first')
        self.commit({'game':vector['value']},'first',id='legacy-latest')
        self.assertFalse(self.store.has_chunk_save())
        self.assertEqual(self.store.export_all()['data']['game'],vector['value'])

    def test_chunk_metadata_corruption_is_detected(self):
        vector = json.loads((ROOT / '.tmp/chunk-storage/vectors.json').read_text(encoding='utf-8'))[2]
        self.stage_chunk(vector,'first'); self.store.commit_chunk_save('first')
        row = json.loads(self.store.conn.execute("SELECT metadata FROM chunk_saves WHERE id='first'").fetchone()[0])
        row['hashes']['renamed'] = row['hashes'].pop('game')
        with self.store.conn: self.store.conn.execute("UPDATE chunk_saves SET metadata=? WHERE id='first'", (json.dumps(row),))
        with self.assertRaisesRegex(ValueError,'Save root'): self.store.export_meta()


if __name__ == "__main__":
    unittest.main()
