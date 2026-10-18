// This factory is also embedded in the bridge and its dedicated Web Worker.
function createStorageChunkCodec() {
  const encoder = new TextEncoder();
  const gear = new Uint32Array(256);
  let seed = 0x9e3779b9;
  for (let i = 0; i < gear.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; gear[i] = seed >>> 0; }
  const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  const sha = async bytes => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  function canonical(m) {
    return `22\n${m.encoding}\n${m.chars}\n${m.bytes}\n` + m.chunks.map(c => `${c.hash}:${c.bytes}\n`).join('');
  }
  function encodeText(text) {
    // Preserve isolated surrogates and leading BOMs (XHR strips a UTF-8 BOM).
    if (text.charCodeAt(0) === 0xfeff || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) {
      const bytes = new Uint8Array(text.length * 2);
      for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); bytes[i * 2] = c & 255; bytes[i * 2 + 1] = c >>> 8; }
      return { encoding: 'utf16le', bytes };
    }
    return { encoding: 'utf8', bytes: encoder.encode(text) };
  }
  async function encode(text, options = {}) {
    const started = performance.now();
    const { encoding, bytes } = encodeText(text);
    const min = options.min || 32768, max = options.max || 524288, mask = (options.average || 131072) - 1;
    const manifest = { encoding, chars: text.length, bytes: bytes.length, chunks: [] };
    const buffers = new Map();
    // Inline values retain a real byte encoding too; no JSON interpretation occurs.
    if (bytes.length <= 65536 && encoding === 'utf8') {
      manifest.inline = text;
      manifest.root = await sha(encoder.encode('22\ninline\n' + text));
    } else {
      let start = 0, rolling = 0;
      for (let i = 0; i < bytes.length; i++) {
        rolling = ((rolling << 1) + gear[bytes[i]]) >>> 0;
        const size = i + 1 - start;
        if (size >= min && ((rolling & mask) === 0 || size >= max) || i === bytes.length - 1) {
          const chunk = bytes.slice(start, i + 1);
          const hash = await sha(chunk);
          manifest.chunks.push({ hash, bytes: chunk.length });
          buffers.set(hash, chunk);
          start = i + 1; rolling = 0;
        }
      }
      manifest.root = await sha(encoder.encode(canonical(manifest)));
    }
    return { manifest, buffers, elapsedMs: performance.now() - started, scannedBytes: bytes.length };
  }
  async function verify(manifest) {
    const input = manifest.inline !== undefined ? '22\ninline\n' + manifest.inline : canonical(manifest);
    return await sha(encoder.encode(input)) === manifest.root;
  }
  async function snapshotRoot(save) {
    const header = `22-save\n${save.id}\n${save.baseId}\n${save.revision}\n${save.updatedAt}\n${save.legacyUpdatedAt}\n`;
    const entries = Object.keys(save.entries).sort().map(key => `${key.length}:${key}:${save.entries[key]}\n`).join('');
    return sha(encoder.encode(header + entries));
  }
  async function decode(bytes, manifest) {
    if (!await verify(manifest) || bytes.length !== manifest.bytes) throw new Error('Value manifest mismatch');
    if (manifest.inline === undefined) {
      let offset = 0;
      for (const chunk of manifest.chunks) { if (await sha(bytes.subarray(offset, offset + chunk.bytes)) !== chunk.hash) throw new Error('Chunk SHA-256 mismatch'); offset += chunk.bytes; }
    }
    let text;
    if (manifest.encoding === 'utf16le') {
      const parts = [];
      for (let offset = 0; offset < bytes.length; offset += 16384) {
        const chars = [];
        for (let i = offset; i < Math.min(bytes.length, offset + 16384); i += 2) chars.push(bytes[i] | bytes[i + 1] << 8);
        parts.push(String.fromCharCode(...chars));
      }
      text = parts.join('');
    } else text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.length !== manifest.chars || manifest.inline !== undefined && text !== manifest.inline) throw new Error('Value character length mismatch');
    return text;
  }
  function pack(items) {
    const size = items.reduce((n, item) => n + 36 + item.bytes.length, 4);
    if (size > 1048576) throw new Error('Chunk batch exceeds 1 MiB');
    const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
    view.setUint32(0, items.length, true);
    let offset = 4;
    for (const item of items) {
      for (let i = 0; i < 32; i++) bytes[offset + i] = parseInt(item.hash.slice(i * 2, i * 2 + 2), 16);
      view.setUint32(offset + 32, item.bytes.length, true);
      bytes.set(item.bytes, offset + 36); offset += 36 + item.bytes.length;
    }
    return bytes;
  }
  return { encode, decode, verify, snapshotRoot, canonical, pack, sha };
}
if (typeof module !== 'undefined') module.exports = { createStorageChunkCodec };
