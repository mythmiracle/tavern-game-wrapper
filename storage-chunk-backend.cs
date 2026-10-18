namespace NeutralinoSqliteExtension
{
    using System;
    using System.Collections;
    using System.Collections.Generic;
    using System.IO;
    using System.Text;
    using System.Runtime.InteropServices;
    using System.Web.Script.Serialization;

    public sealed partial class SqliteDeltaStore
    {
        private readonly HashSet<string> _checkedChunks = new HashSet<string>();
        private readonly HashSet<string> _checkedValues = new HashSet<string>();
        private readonly Dictionary<string, int> _chunkReadPins = new Dictionary<string, int>();
        private void ChunkSchema()
        {
            ExecSql(GetDb(), "CREATE TABLE IF NOT EXISTS chunk_blobs (hash TEXT PRIMARY KEY, data BLOB NOT NULL, created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS chunk_values (root TEXT PRIMARY KEY, manifest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS chunk_saves (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS chunk_uploads (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL);");
        }
        private void ChunkExec(string sql, params object[] values)
        {
            IntPtr stmt; PrepareStmt(GetDb(), sql, out stmt);
            try { ChunkBind(stmt, values); StepDone(stmt, "chunkWrite"); }
            finally { WinSqlite3.sqlite3_finalize(stmt); }
        }
        private void ChunkBind(IntPtr stmt, object[] values)
        {
            for (int i = 0; i < values.Length; i++)
            {
                var bytes = values[i] as byte[];
                if (bytes != null) { if (WinSqlite3.sqlite3_bind_blob(stmt, i + 1, bytes, bytes.Length, WinSqlite3.SQLITE_TRANSIENT) != 0) throw new Exception("Chunk bind failed"); }
                else BindText(stmt, i + 1, Convert.ToString(values[i]));
            }
        }
        private string ChunkText(string sql, params object[] values)
        {
            IntPtr stmt; PrepareStmt(GetDb(), sql, out stmt);
            try { ChunkBind(stmt, values); int rc = WinSqlite3.sqlite3_step(stmt); if (rc == WinSqlite3.SQLITE_DONE) return null; if (rc != WinSqlite3.SQLITE_ROW) throw new Exception("Chunk query failed"); return GetColumnText(stmt, 0); }
            finally { WinSqlite3.sqlite3_finalize(stmt); }
        }
        private byte[] ChunkBytes(string hash)
        {
            IntPtr stmt; PrepareStmt(GetDb(), "SELECT data FROM chunk_blobs WHERE hash = ?", out stmt);
            try {
                BindText(stmt, 1, hash); if (WinSqlite3.sqlite3_step(stmt) != WinSqlite3.SQLITE_ROW) throw new Exception("Missing chunk: " + hash);
                int size = WinSqlite3.sqlite3_column_bytes(stmt, 0); byte[] bytes = new byte[size];
                if (size > 0) Marshal.Copy(WinSqlite3.sqlite3_column_blob(stmt, 0), bytes, 0, size);
                if (!_checkedChunks.Contains(hash)) { if (ChunkHash(bytes) != hash) throw new Exception("Chunk SHA-256 mismatch"); _checkedChunks.Add(hash); }
                return bytes;
            } finally { WinSqlite3.sqlite3_finalize(stmt); }
        }
        private static string ChunkHash(byte[] bytes)
        {
            using (var sha = System.Security.Cryptography.SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
        }
        private static Dictionary<string, object> ChunkObject(object value) { return (Dictionary<string, object>)value; }
        private static JavaScriptSerializer ChunkSerializer() { return new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 1024 }; }
        public bool HasChunkSave() { return ChunkText("SELECT meta_value FROM storage_meta WHERE meta_key = 'chunk_active'") != null; }
        private string CurrentSaveId()
        {
            string active = ChunkText("SELECT meta_value FROM storage_meta WHERE meta_key = 'chunk_active'");
            if (active != null) return active;
            var prior = ReadSaveCommit(ChunkSerializer()); return prior == null ? "" : Convert.ToString(prior["id"]);
        }
        private Dictionary<string, object> ChunkSave(string id)
        {
            string raw = ChunkText("SELECT metadata FROM chunk_saves WHERE id = ?", id ?? CurrentSaveId());
            if (raw == null) throw new Exception("Save generation unavailable");
            var save = ChunkSerializer().Deserialize<Dictionary<string, object>>(raw);
            var payload = new Dictionary<string, object>(save); payload["entries"] = save["hashes"];
            if (Convert.ToString(save["rootHash"]) != SnapshotHash(payload) || Convert.ToInt32(save["keyCount"]) != ChunkObject(save["hashes"]).Count) throw new Exception("Save root SHA-256 mismatch");
            return save;
        }
        private Dictionary<string, object> ChunkManifest(string root)
        {
            string raw = ChunkText("SELECT manifest FROM chunk_values WHERE root = ?", root);
            if (raw == null) throw new Exception("Missing value manifest");
            var manifest = ChunkSerializer().Deserialize<Dictionary<string, object>>(raw);
            if (Convert.ToString(manifest["root"]) != root) throw new Exception("Value root reference mismatch");
            return manifest;
        }
        private void ValidateManifest(Dictionary<string, object> m, bool contents)
        {
            string encoding = Convert.ToString(m["encoding"]);
            if (encoding != "utf8" && encoding != "utf16le") throw new Exception("Unknown chunk encoding");
            long length = Convert.ToInt64(m["bytes"]), chars = Convert.ToInt64(m["chars"]);
            if (length < 0 || chars < 0) throw new Exception("Invalid value length");
            string canonical;
            if (m.ContainsKey("inline")) {
                string text = Convert.ToString(m["inline"]);
                if (encoding != "utf8" || Encoding.UTF8.GetByteCount(text) != length || text.Length != chars || length > 65536) throw new Exception("Invalid inline value");
                canonical = "22\ninline\n" + text;
            } else {
                var text = new StringBuilder("22\n" + encoding + "\n" + chars + "\n" + length + "\n"); long total = 0;
                foreach (object item in (IEnumerable)m["chunks"]) {
                    var c = ChunkObject(item); string hash = Convert.ToString(c["hash"]); int count = Convert.ToInt32(c["bytes"]);
                    if (hash.Length != 64 || count <= 0 || count > 524288) throw new Exception("Invalid chunk descriptor");
                    total += count; text.Append(hash).Append(':').Append(count).Append('\n');
                    if (contents) { string storedLength = ChunkText("SELECT length(data) FROM chunk_blobs WHERE hash = ?", hash); if (storedLength == null || Convert.ToInt32(storedLength) != count) throw new Exception("Missing chunk"); if (!_checkedChunks.Contains(hash)) ChunkBytes(hash); }
                }
                if (total != length || encoding == "utf16le" && length != chars * 2) throw new Exception("Value length mismatch"); canonical = text.ToString();
            }
            if (ChunkHash(Encoding.UTF8.GetBytes(canonical)) != Convert.ToString(m["root"])) throw new Exception("Manifest SHA-256 mismatch");
            if (contents && !m.ContainsKey("inline") && !_checkedValues.Contains(Convert.ToString(m["root"]))) {
                long count = 0;
                if (encoding == "utf8") {
                    var decoder = new UTF8Encoding(false, true).GetDecoder();
                    var charBuffer = new char[524290];
                    foreach (object item in (IEnumerable)m["chunks"]) { byte[] bytes = ChunkBytes(Convert.ToString(ChunkObject(item)["hash"])); count += decoder.GetChars(bytes, 0, bytes.Length, charBuffer, 0, false); }
                    count += decoder.GetChars(new byte[0], 0, 0, charBuffer, 0, true);
                } else count = length / 2;
                if (count != chars) throw new Exception("Character length mismatch");
                _checkedValues.Add(Convert.ToString(m["root"]));
            }
        }
        private static string SnapshotHash(Dictionary<string, object> p)
        {
            var entries = ChunkObject(p["entries"]); var keys = new List<string>(entries.Keys); keys.Sort(StringComparer.Ordinal);
            var text = new StringBuilder("22-save\n" + p["id"] + "\n" + p["baseId"] + "\n" + p["revision"] + "\n" + p["updatedAt"] + "\n" + p["legacyUpdatedAt"] + "\n");
            foreach (string key in keys) text.Append(key.Length).Append(':').Append(key).Append(':').Append(entries[key]).Append('\n');
            return ChunkHash(Encoding.UTF8.GetBytes(text.ToString()));
        }
        public Dictionary<string, object> PrepareChunkSave(Dictionary<string, object> payload)
        {
            lock (_sync) {
                ChunkSchema(); var ser = ChunkSerializer(); string id = Convert.ToString(payload["id"]);
                if (!payload.ContainsKey("rootHash") || Convert.ToString(payload["rootHash"]) != SnapshotHash(payload)) throw new Exception("Save root SHA-256 mismatch");
                if (string.IsNullOrEmpty(id) || CurrentSaveId() != Convert.ToString(payload["baseId"])) throw new Exception("Save conflict: reload the current save");
                var missing = new HashSet<string>();
                foreach (object item in (IEnumerable)payload["manifests"]) {
                    var m = ChunkObject(item); ValidateManifest(m, false);
                    string root = Convert.ToString(m["root"]), raw = ser.Serialize(m);
                    ChunkExec("INSERT OR IGNORE INTO chunk_values(root,manifest) VALUES(?,?)", root, raw);
                }
                foreach (var entry in ChunkObject(payload["entries"])) {
                    var m = ChunkManifest(Convert.ToString(entry.Value)); ValidateManifest(m, false);
                    foreach (object item in (IEnumerable)m["chunks"]) { var c = ChunkObject(item); string hash = Convert.ToString(c["hash"]); if (ChunkText("SELECT hash FROM chunk_blobs WHERE hash = ?", hash) == null) missing.Add(hash); }
                }
                string previous = ChunkText("SELECT payload FROM chunk_uploads WHERE id = ?", id), json = ser.Serialize(payload);
                if (previous != null && previous != json) throw new Exception("Upload id already used");
                ChunkExec("INSERT OR IGNORE INTO chunk_uploads(id,payload,created_at) VALUES(?,?,?)", id, json, NowMs());
                return new Dictionary<string, object> { {"ok", true}, {"missing", new List<string>(missing)} };
            }
        }
        public Dictionary<string, object> PutChunkBatch(string id, byte[] body)
        {
            if (body.Length < 4 || body.Length > 1048576) throw new Exception("Invalid chunk batch size");
            lock (_sync) {
                ChunkSchema(); if (ChunkText("SELECT id FROM chunk_uploads WHERE id = ?", id) == null) throw new Exception("Upload expired");
                int count = BitConverter.ToInt32(body, 0), offset = 4;
                if (count < 0 || count > 64) throw new Exception("Invalid chunk count");
                ExecSql(GetDb(), "BEGIN IMMEDIATE");
                try {
                    for (int i = 0; i < count; i++) {
                        if (offset + 36 > body.Length) throw new Exception("Truncated chunk batch");
                        string hash = BitConverter.ToString(body, offset, 32).Replace("-", "").ToLowerInvariant(); int size = BitConverter.ToInt32(body, offset + 32); offset += 36;
                        if (size <= 0 || size > 524288 || size > body.Length - offset) throw new Exception("Invalid chunk size");
                        byte[] bytes = new byte[size]; Buffer.BlockCopy(body, offset, bytes, 0, size); offset += size;
                        if (ChunkHash(bytes) != hash) throw new Exception("Chunk SHA-256 mismatch");
                        ChunkExec("INSERT OR IGNORE INTO chunk_blobs(hash,data,created_at) VALUES(?,?,?)", hash, bytes, NowMs());
                        _checkedChunks.Remove(hash); ChunkBytes(hash);
                    }
                    if (offset != body.Length) throw new Exception("Trailing chunk batch bytes"); ExecSql(GetDb(), "COMMIT");
                } catch { ExecSql(GetDb(), "ROLLBACK"); _checkedChunks.Clear(); throw; }
                return new Dictionary<string, object> { {"ok", true}, {"bytes", body.Length} };
            }
        }
        public Dictionary<string, object> CommitChunkSave(string id)
        {
            lock (_sync) {
                ChunkSchema(); if (HasChunkSave() && CurrentSaveId() == id) return new Dictionary<string, object> { {"ok", true}, {"commit", ChunkSave(id)} };
                string raw = ChunkText("SELECT payload FROM chunk_uploads WHERE id = ?", id); if (raw == null) throw new Exception("Upload expired");
                var p = ChunkSerializer().Deserialize<Dictionary<string, object>>(raw); var entries = ChunkObject(p["entries"]);
                ExecSql(GetDb(), "BEGIN IMMEDIATE");
                try {
                    if (CurrentSaveId() != Convert.ToString(p["baseId"])) throw new Exception("Save conflict: reload the current save");
                    foreach (var pair in entries) ValidateManifest(ChunkManifest(Convert.ToString(pair.Value)), true);
                    var commit = new Dictionary<string, object> { {"id", id}, {"format", 22}, {"baseId", p["baseId"]}, {"rootHash", p["rootHash"]}, {"revision", p["revision"]}, {"updatedAt", p["updatedAt"]}, {"legacyUpdatedAt", p["legacyUpdatedAt"]}, {"hashes", entries}, {"keyCount", entries.Count}, {"verified", true} };
                    ChunkExec("INSERT INTO chunk_saves(id,metadata,created_at) VALUES(?,?,?)", id, ChunkSerializer().Serialize(commit), NowMs());
                    ChunkExec("INSERT OR REPLACE INTO storage_meta(meta_key,meta_value,updated_at) VALUES('chunk_active',?,?)", id, NowMs());
                    ChunkExec("DELETE FROM chunk_uploads WHERE id = ?", id); ExecSql(GetDb(), "COMMIT");
                    return new Dictionary<string, object> { {"ok", true}, {"commit", commit} };
                } catch { ExecSql(GetDb(), "ROLLBACK"); throw; }
            }
        }
        public Dictionary<string, object> ExportChunkMeta(string id)
        {
            lock (_sync) {
                var commit = ChunkSave(id); var values = new Dictionary<string, object>(); var small = new Dictionary<string, string>(); var large = new List<string>();
                foreach (var entry in ChunkObject(commit["hashes"])) { var m = ChunkManifest(Convert.ToString(entry.Value)); ValidateManifest(m, false); values[entry.Key] = m; if (m.ContainsKey("inline")) small[entry.Key] = Convert.ToString(m["inline"]); else large.Add(entry.Key); }
                return new Dictionary<string, object> { {"ok", true}, {"version", 22}, {"format", 22}, {"backend", "winsqlite3-native"}, {"saveCommit", commit}, {"totalKeys", values.Count}, {"updatedAt", commit["updatedAt"]}, {"values", values}, {"inlineData", small}, {"largeKeys", large} };
            }
        }
        public void StreamChunkValue(string key, string id, Action<long, string> header, Action<byte[]> write)
        {
            Dictionary<string, object> manifest; string saveId;
            lock (_sync) { var save = ChunkSave(id); saveId = Convert.ToString(save["id"]); var entries = ChunkObject(save["hashes"]); if (!entries.ContainsKey(key)) throw new Exception("Key not found"); manifest = ChunkManifest(Convert.ToString(entries[key])); ValidateManifest(manifest, true); if (!_chunkReadPins.ContainsKey(saveId)) _chunkReadPins[saveId] = 0; _chunkReadPins[saveId]++; }
            try {
                header(Convert.ToInt64(manifest["bytes"]), Convert.ToString(manifest["encoding"]));
                if (manifest.ContainsKey("inline")) write(Encoding.UTF8.GetBytes(Convert.ToString(manifest["inline"])));
                else foreach (object item in (IEnumerable)manifest["chunks"]) { byte[] bytes; lock (_sync) { bytes = ChunkBytes(Convert.ToString(ChunkObject(item)["hash"])); } write(bytes); }
            } finally { lock (_sync) { if (--_chunkReadPins[saveId] == 0) _chunkReadPins.Remove(saveId); } }
        }
        public string ReadChunkValue(string key, string id)
        {
            using (var output = new MemoryStream()) { string encoding = "utf8"; StreamChunkValue(key, id, (length, codec) => { encoding = codec; }, bytes => output.Write(bytes, 0, bytes.Length));
                byte[] data = output.ToArray(); if (encoding == "utf8") return new UTF8Encoding(false, true).GetString(data);
                char[] chars = new char[data.Length / 2]; for (int i = 0; i < chars.Length; i++) chars[i] = (char)(data[i * 2] | data[i * 2 + 1] << 8); return new string(chars); }
        }
        public Dictionary<string, object> ExportChunkAll(string id)
        {
            lock (_sync) { var meta = ExportChunkMeta(id); string saveId = Convert.ToString(ChunkObject(meta["saveCommit"])["id"]); var data = new Dictionary<string, string>(); foreach (var key in ChunkObject(ChunkObject(meta["saveCommit"])["hashes"]).Keys) data[key] = ReadChunkValue(key, saveId); meta["data"] = data; return meta; }
        }
        public Dictionary<string, object> CollectChunks()
        {
            lock (_sync) {
                ChunkSchema(); long cutoff = NowMs() - 86400000;
                ChunkExec("DELETE FROM chunk_uploads WHERE created_at < ?", cutoff);
                var keepRoots = new HashSet<string>(); var keepChunks = new HashSet<string>();
                var ids = new List<string>(); IntPtr stmt; PrepareStmt(GetDb(), "SELECT id FROM chunk_saves ORDER BY created_at DESC", out stmt);
                try { while (WinSqlite3.sqlite3_step(stmt) == WinSqlite3.SQLITE_ROW) ids.Add(GetColumnText(stmt, 0)); } finally { WinSqlite3.sqlite3_finalize(stmt); }
                for (int i = 0; i < ids.Count; i++) { if (i < 2 || ids[i] == CurrentSaveId() || _chunkReadPins.ContainsKey(ids[i]) || Convert.ToInt64(ChunkText("SELECT created_at FROM chunk_saves WHERE id = ?", ids[i])) > NowMs() - 120000) { foreach (var pair in ChunkObject(ChunkSave(ids[i])["hashes"])) keepRoots.Add(Convert.ToString(pair.Value)); } else ChunkExec("DELETE FROM chunk_saves WHERE id = ?", ids[i]); }
                PrepareStmt(GetDb(), "SELECT payload FROM chunk_uploads", out stmt);
                try { while (WinSqlite3.sqlite3_step(stmt) == WinSqlite3.SQLITE_ROW) foreach (var pair in ChunkObject(ChunkSerializer().Deserialize<Dictionary<string, object>>(GetColumnText(stmt, 0))["entries"])) keepRoots.Add(Convert.ToString(pair.Value)); } finally { WinSqlite3.sqlite3_finalize(stmt); }
                foreach (string root in keepRoots) foreach (object item in (IEnumerable)ChunkManifest(root)["chunks"]) keepChunks.Add(Convert.ToString(ChunkObject(item)["hash"]));
                var remove = new List<string>(); PrepareStmt(GetDb(), "SELECT hash FROM chunk_blobs", out stmt);
                try { while (WinSqlite3.sqlite3_step(stmt) == WinSqlite3.SQLITE_ROW) { string hash = GetColumnText(stmt, 0); if (!keepChunks.Contains(hash)) remove.Add(hash); } } finally { WinSqlite3.sqlite3_finalize(stmt); }
                var removeValues = new List<string>(); PrepareStmt(GetDb(), "SELECT root FROM chunk_values", out stmt);
                try { while (WinSqlite3.sqlite3_step(stmt) == WinSqlite3.SQLITE_ROW) { string value = GetColumnText(stmt, 0); if (!keepRoots.Contains(value)) removeValues.Add(value); } } finally { WinSqlite3.sqlite3_finalize(stmt); }
                ExecSql(GetDb(), "BEGIN IMMEDIATE"); try { foreach (string hash in remove) { ChunkExec("DELETE FROM chunk_blobs WHERE hash = ?", hash); _checkedChunks.Remove(hash); } foreach (string value in removeValues) { ChunkExec("DELETE FROM chunk_values WHERE root = ?", value); _checkedValues.Remove(value); } ExecSql(GetDb(), "COMMIT"); } catch { ExecSql(GetDb(), "ROLLBACK"); throw; }
                return new Dictionary<string, object> { {"ok", true}, {"removedChunks", remove.Count} };
            }
        }
        public static string EscapeJsonSurrogates(string json)
        {
            var output = new StringBuilder(json.Length);
            foreach (char c in json) { if (char.IsSurrogate(c)) output.Append("\\u").Append(((int)c).ToString("x4")); else output.Append(c); }
            return output.ToString();
        }
    }
}
