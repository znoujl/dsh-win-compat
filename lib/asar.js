/**
 * Tiny, dependency-free ASAR reader for version/metadata probes.
 *
 * The plugin must report the installed DSH runtime version without spawning
 * the `dsh` CLI. The runtime package lives inside `resources/app.asar`, so we
 * parse that archive directly (header JSON + entry offsets). Electron's fs
 * wrapper intercepts `*.asar` paths, hence the temporary `process.noAsar`
 * switch around the synchronous reads.
 *
 * Supports both header layouts seen in the wild:
 *   - modern: [0]=4, [4]=span, [8]=len+4, [12]=len, JSON at 16
 *   - classic: [0]=4, [4]=len, JSON at 8
 */
import fs from 'node:fs';

const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

function lookup(header, entryPath) {
  let node = header;
  for (const part of entryPath.split('/')) {
    if (!node || typeof node.files !== 'object') return null;
    node = node.files[part];
  }
  return node ?? null;
}

/**
 * Read one archived file.
 * @param {string} asarPath absolute path to app.asar
 * @param {string} entryPath slash-separated path inside the archive
 * @returns {Buffer|null} null for missing entries or unreadable archives
 */
export function readAsarEntry(asarPath, entryPath) {
  const previousNoAsar = process.noAsar;
  let fd;
  try {
    process.noAsar = true;
    if (!fs.statSync(asarPath).isFile()) return null;
    fd = fs.openSync(asarPath, 'r');
    const head = Buffer.alloc(32);
    fs.readSync(fd, head, 0, 32, 0);

    const layouts = [
      { jsonStart: 16, jsonLength: head.readUInt32LE(12) },
      { jsonStart: 8, jsonLength: head.readUInt32LE(4) },
    ];

    for (const layout of layouts) {
      if (!(layout.jsonLength > 0) || layout.jsonLength > MAX_HEADER_BYTES) continue;
      const json = Buffer.alloc(layout.jsonLength);
      fs.readSync(fd, json, 0, layout.jsonLength, layout.jsonStart);
      let header;
      try {
        header = JSON.parse(json.toString('utf8'));
      } catch {
        continue;
      }
      if (!header || typeof header.files !== 'object') continue;
      const node = lookup(header, entryPath);
      if (!node || node.files || node.offset === undefined || node.offset === null) return null;
      const size = Number(node.size);
      const offset = Number(node.offset);
      if (!Number.isFinite(size) || size < 0 || size > MAX_ENTRY_BYTES) return null;
      if (!Number.isFinite(offset) || offset < 0) return null;
      const dataStart = layout.jsonStart + layout.jsonLength;
      const buffer = Buffer.alloc(size);
      fs.readSync(fd, buffer, 0, size, dataStart + offset);
      return buffer;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    process.noAsar = previousNoAsar;
  }
}

/** Read and parse a JSON entry; null when absent or invalid. */
export function readAsarJson(asarPath, entryPath) {
  const buffer = readAsarEntry(asarPath, entryPath);
  if (buffer === null) return null;
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}
