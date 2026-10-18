class ChunkStoreMixin:
    def _chunk_schema(self):
        self.conn.executescript("CREATE TABLE IF NOT EXISTS chunk_blobs(hash TEXT PRIMARY KEY,data BLOB NOT NULL,created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS chunk_values(root TEXT PRIMARY KEY,manifest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS chunk_saves(id TEXT PRIMARY KEY,metadata TEXT NOT NULL,created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS chunk_uploads(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at INTEGER NOT NULL);")
        if not hasattr(self, '_checked_chunks'): self._checked_chunks, self._checked_values, self._chunk_pins = set(), set(), {}

    def has_chunk_save(self):
        return self.conn.execute("SELECT meta_value FROM storage_meta WHERE meta_key='chunk_active'").fetchone() is not None

    def _chunk_current_id(self):
        row = self.conn.execute("SELECT meta_value FROM storage_meta WHERE meta_key='chunk_active'").fetchone()
        return row[0] if row else (self._read_commit() or {}).get('id', '')

    def _chunk_save(self, save_id=None):
        row = self.conn.execute('SELECT metadata FROM chunk_saves WHERE id=?', (save_id or self._chunk_current_id(),)).fetchone()
        if row is None: raise ValueError('Save generation unavailable')
        save = json.loads(row[0])
        if save['rootHash'] != self._snapshot_hash(dict(save, entries=save['hashes'])) or save['keyCount'] != len(save['hashes']): raise ValueError('Save root SHA-256 mismatch')
        return save

    @staticmethod
    def _snapshot_hash(p):
        canonical = '22-save\n%s\n%s\n%d\n%d\n%d\n' % (p['id'],p['baseId'],p['revision'],p['updatedAt'],p['legacyUpdatedAt'])
        for key in sorted(p['entries'], key=lambda value: value.encode('utf-16-be',errors='surrogatepass')):
            canonical += '%d:%s:%s\n' % (len(key.encode('utf-16-le',errors='surrogatepass'))//2,key,p['entries'][key])
        return hashlib.sha256(canonical.encode()).hexdigest()

    def _chunk_manifest(self, root):
        row = self.conn.execute('SELECT manifest FROM chunk_values WHERE root=?', (root,)).fetchone()
        if row is None: raise ValueError('Missing value manifest')
        manifest = json.loads(row[0])
        if manifest['root'] != root: raise ValueError('Value root reference mismatch')
        return manifest

    def _chunk_bytes(self, sha):
        row = self.conn.execute('SELECT data FROM chunk_blobs WHERE hash=?', (sha,)).fetchone()
        if row is None: raise ValueError('Missing chunk')
        data = row[0]
        if sha not in self._checked_chunks:
            if hashlib.sha256(data).hexdigest() != sha: raise ValueError('Chunk SHA-256 mismatch')
            self._checked_chunks.add(sha)
        return data

    def _chunk_validate(self, manifest, contents=False):
        codec, length, chars = manifest['encoding'], int(manifest['bytes']), int(manifest['chars'])
        if codec not in ('utf8', 'utf16le') or length < 0 or chars < 0: raise ValueError('Invalid encoding or length')
        if 'inline' in manifest:
            text = manifest['inline']
            if codec != 'utf8' or len(text.encode()) != length or len(text.encode('utf-16-le')) // 2 != chars or length > 65536: raise ValueError('Invalid inline value')
            canonical = '22\ninline\n' + text
        else:
            canonical = '22\n%s\n%d\n%d\n' % (codec, chars, length)
            total = 0
            for chunk in manifest['chunks']:
                size, sha = int(chunk['bytes']), chunk['hash']
                if len(sha) != 64 or size <= 0 or size > 524288: raise ValueError('Invalid chunk descriptor')
                total += size
                canonical += '%s:%d\n' % (sha, size)
                if contents:
                    row = self.conn.execute('SELECT length(data) FROM chunk_blobs WHERE hash=?', (sha,)).fetchone()
                    if row is None or row[0] != size: raise ValueError('Missing chunk')
                    if sha not in self._checked_chunks: self._chunk_bytes(sha)
            if total != length or codec == 'utf16le' and length != chars * 2: raise ValueError('Value length mismatch')
        if hashlib.sha256(canonical.encode()).hexdigest() != manifest['root']: raise ValueError('Manifest SHA-256 mismatch')
        if contents and 'inline' not in manifest and manifest['root'] not in self._checked_values:
            if codec == 'utf8':
                import codecs
                decoder = codecs.getincrementaldecoder('utf-8')('strict')
                count = 0
                for chunk in manifest['chunks']: count += len(decoder.decode(self._chunk_bytes(chunk['hash'])).encode('utf-16-le')) // 2
                count += len(decoder.decode(b'', final=True).encode('utf-16-le')) // 2
            else: count = length // 2
            if count != chars: raise ValueError('Character length mismatch')
            self._checked_values.add(manifest['root'])

    def prepare_chunk_save(self, payload):
        with self.lock:
            self._chunk_schema()
            if payload.get('rootHash') != self._snapshot_hash(payload): raise ValueError('Save root SHA-256 mismatch')
            if not payload.get('id') or self._chunk_current_id() != payload['baseId']: raise ValueError('Save conflict: reload the current save')
            missing = set()
            with self.conn:
                for manifest in payload['manifests']:
                    self._chunk_validate(manifest)
                    self.conn.execute('INSERT OR IGNORE INTO chunk_values(root,manifest) VALUES(?,?)', (manifest['root'], json.dumps(manifest, ensure_ascii=True)))
                for root in payload['entries'].values():
                    manifest = self._chunk_manifest(root)
                    self._chunk_validate(manifest)
                    for chunk in manifest['chunks']:
                        if self.conn.execute('SELECT hash FROM chunk_blobs WHERE hash=?', (chunk['hash'],)).fetchone() is None: missing.add(chunk['hash'])
                previous = self.conn.execute('SELECT payload FROM chunk_uploads WHERE id=?', (payload['id'],)).fetchone()
                raw = json.dumps(payload, ensure_ascii=True)
                if previous and previous[0] != raw: raise ValueError('Upload id already used')
                self.conn.execute('INSERT OR IGNORE INTO chunk_uploads(id,payload,created_at) VALUES(?,?,?)', (payload['id'], raw, int(time.time()*1000)))
            return dict(ok=True, missing=sorted(missing))

    def put_chunk_batch(self, upload_id, body):
        import struct
        if len(body) < 4 or len(body) > 1048576: raise ValueError('Invalid chunk batch size')
        with self.lock:
            self._chunk_schema()
            if self.conn.execute('SELECT id FROM chunk_uploads WHERE id=?', (upload_id,)).fetchone() is None: raise ValueError('Upload expired')
            count, offset = struct.unpack_from('<I', body)[0], 4
            if count > 64: raise ValueError('Invalid chunk count')
            try:
                with self.conn:
                    for _ in range(count):
                        if offset + 36 > len(body): raise ValueError('Truncated chunk batch')
                        sha, size = body[offset:offset+32].hex(), struct.unpack_from('<I', body, offset+32)[0]
                        offset += 36
                        if size <= 0 or size > 524288 or offset + size > len(body): raise ValueError('Invalid chunk size')
                        data = body[offset:offset+size]; offset += size
                        if hashlib.sha256(data).hexdigest() != sha: raise ValueError('Chunk SHA-256 mismatch')
                        self.conn.execute('INSERT OR IGNORE INTO chunk_blobs(hash,data,created_at) VALUES(?,?,?)', (sha, data, int(time.time()*1000)))
                        self._checked_chunks.discard(sha); self._chunk_bytes(sha)
                    if offset != len(body): raise ValueError('Trailing chunk batch bytes')
            except Exception:
                self._checked_chunks.clear()
                raise
            return dict(ok=True, bytes=len(body))

    def commit_chunk_save(self, upload_id):
        with self.lock:
            self._chunk_schema()
            if self.has_chunk_save() and self._chunk_current_id() == upload_id: return dict(ok=True, commit=self._chunk_save(upload_id))
            row = self.conn.execute('SELECT payload FROM chunk_uploads WHERE id=?', (upload_id,)).fetchone()
            if row is None: raise ValueError('Upload expired')
            payload = json.loads(row[0])
            self.conn.execute('BEGIN IMMEDIATE')
            try:
                if self._chunk_current_id() != payload['baseId']: raise ValueError('Save conflict: reload the current save')
                for root in payload['entries'].values(): self._chunk_validate(self._chunk_manifest(root), True)
                commit = dict(id=upload_id, format=22, baseId=payload['baseId'], rootHash=payload['rootHash'], revision=payload['revision'], updatedAt=payload['updatedAt'], legacyUpdatedAt=payload['legacyUpdatedAt'], hashes=payload['entries'], keyCount=len(payload['entries']), verified=True)
                self.conn.execute('INSERT INTO chunk_saves(id,metadata,created_at) VALUES(?,?,?)', (upload_id, json.dumps(commit, ensure_ascii=True), int(time.time()*1000)))
                self.conn.execute("INSERT OR REPLACE INTO storage_meta(meta_key,meta_value,updated_at) VALUES('chunk_active',?,?)", (upload_id, int(time.time()*1000)))
                self.conn.execute('DELETE FROM chunk_uploads WHERE id=?', (upload_id,))
                self.conn.commit()
            except Exception:
                self.conn.rollback(); raise
            return dict(ok=True, commit=commit)

    def export_chunk_meta(self, save_id=None):
        with self.lock:
            commit = self._chunk_save(save_id)
            values = {key: self._chunk_manifest(root) for key, root in commit['hashes'].items()}
            for value in values.values(): self._chunk_validate(value)
            return dict(ok=True, version=22, format=22, backend='python-sqlite3', saveCommit=commit, totalKeys=len(values), updatedAt=commit['updatedAt'], values=values,
                        inlineData={k: m['inline'] for k, m in values.items() if 'inline' in m}, largeKeys=[k for k, m in values.items() if 'inline' not in m])

    def stream_chunk_value(self, key, save_id, header, write):
        with self.lock:
            save = self._chunk_save(save_id); save_id = save['id']
            if key not in save['hashes']: raise ValueError('Key not found')
            manifest = self._chunk_manifest(save['hashes'][key]); self._chunk_validate(manifest, True)
            self._chunk_pins[save_id] = self._chunk_pins.get(save_id, 0) + 1
        try:
            header(manifest['bytes'], manifest['encoding'])
            if 'inline' in manifest: write(manifest['inline'].encode())
            else:
                for chunk in manifest['chunks']:
                    with self.lock: data = self._chunk_bytes(chunk['hash'])
                    write(data)
        finally:
            with self.lock:
                self._chunk_pins[save_id] -= 1
                if not self._chunk_pins[save_id]: del self._chunk_pins[save_id]

    def read_chunk_value(self, key, save_id=None):
        import io
        output, codec = io.BytesIO(), ['utf8']
        self.stream_chunk_value(key, save_id, lambda length, encoding: codec.__setitem__(0, encoding), output.write)
        return output.getvalue().decode('utf-16-le' if codec[0] == 'utf16le' else 'utf-8', errors='surrogatepass')

    def export_chunk_all(self, save_id=None):
        meta = self.export_chunk_meta(save_id)
        meta['data'] = {key: self.read_chunk_value(key, meta['saveCommit']['id']) for key in meta['values']}
        return meta

    def collect_chunks(self):
        with self.lock:
            self._chunk_schema()
            with self.conn:
                self.conn.execute('DELETE FROM chunk_uploads WHERE created_at < ?', (int(time.time()*1000)-86400000,))
                roots, chunks = set(), set()
                ids = list(self.conn.execute('SELECT id FROM chunk_saves ORDER BY created_at DESC'))
                for i, (save_id,) in enumerate(ids):
                    created = self.conn.execute('SELECT created_at FROM chunk_saves WHERE id=?', (save_id,)).fetchone()[0]
                    if i < 2 or save_id == self._chunk_current_id() or save_id in self._chunk_pins or created > int(time.time()*1000)-120000: roots.update(self._chunk_save(save_id)['hashes'].values())
                    else: self.conn.execute('DELETE FROM chunk_saves WHERE id=?', (save_id,))
                for raw, in self.conn.execute('SELECT payload FROM chunk_uploads'): roots.update(json.loads(raw)['entries'].values())
                for root in roots: chunks.update(c['hash'] for c in self._chunk_manifest(root)['chunks'])
                remove = [sha for sha, in self.conn.execute('SELECT hash FROM chunk_blobs') if sha not in chunks]
                self.conn.executemany('DELETE FROM chunk_blobs WHERE hash=?', [(sha,) for sha in remove])
                self._checked_chunks.difference_update(remove)
                old_values = [root for root, in self.conn.execute('SELECT root FROM chunk_values') if root not in roots]
                self.conn.executemany('DELETE FROM chunk_values WHERE root=?', [(root,) for root in old_values])
                self._checked_values.difference_update(old_values)
            return dict(ok=True, removedChunks=len(remove))
