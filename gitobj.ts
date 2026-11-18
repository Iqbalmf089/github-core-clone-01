// Git object model, pkt-line framing and packfiles. Node stdlib only (node:crypto, node:zlib).
// Plain packs only on write (no deltas); read supports OFS/REF deltas for robustness.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: GitObjectType; data: Buffer; }
export type ObjectLookup = (oid: string) => GitObject | undefined;

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;
const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(v: string): boolean { return HEX40.test(v); }

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  h.update(body);
  return h.digest('hex');
}

export interface TreeEntry { mode: string; name: string; oid: string; }

export function parseTree(data: Uint8Array): TreeEntry[] {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < b.length) {
    const sp = b.indexOf(0x20, off);
    const nul = b.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > b.length) throw new Error('tree-parse');
    entries.push({ mode: b.subarray(off, sp).toString('ascii'), name: b.subarray(sp + 1, nul).toString('utf8'), oid: b.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string; }
export function parseCommit(data: Uint8Array): CommitView {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = b.indexOf('\n\n');
  const headEnd = blank < 0 ? b.length : blank;
  const message = blank < 0 ? '' : b.subarray(blank + 2).toString('utf8');
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  for (const line of b.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v; else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v; else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}

export interface TagView { object: string; type: GitObjectType; tag: string; tagger: string; message: string; }
export function parseTag(data: Uint8Array): TagView {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = b.indexOf('\n\n');
  const headEnd = blank < 0 ? b.length : blank;
  const headers = new Map<string, string>();
  for (const line of b.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get('object') ?? '', type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '', tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : b.subarray(blank + 2).toString('utf8'),
  };
}

export function buildCommit(o: { tree: string; parents?: readonly string[]; message: string; author: string; committer?: string; timestamp?: number; timezone?: string }): Buffer {
  const ts = o.timestamp ?? 1700000000;
  const tz = o.timezone ?? '+0000';
  const author = `${o.author} ${ts} ${tz}`;
  const committer = `${o.committer ?? o.author} ${ts} ${tz}`;
  const lines = [`tree ${o.tree}`];
  for (const p of o.parents ?? []) lines.push(`parent ${p}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${o.message}`, 'utf8');
}

/** Every object reachable from roots (commit->tree+parents, tree->entries, tag->target). */
export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup, allowMissing = false): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) if (isObjectId(r)) queue.push(r);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) { if (allowMissing) continue; throw new Error(`missing-object ${oid}`); }
    seen.add(oid);
    if (obj.type === 'commit') { const c = parseCommit(obj.data); queue.push(c.tree); for (const p of c.parents) queue.push(p); }
    else if (obj.type === 'tag') queue.push(parseTag(obj.data).object);
    else if (obj.type === 'tree') for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` (or equal). */
export function isAncestor(lookup: ObjectLookup, tip: string, ancestor: string): boolean {
  if (tip === ancestor) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === ancestor) return true;
      queue.push(p);
    }
  }
  return false;
}

/** Flatten a tree (commit oid or tree oid) to path -> {oid, mode}. */
export function flattenTree(lookup: ObjectLookup, rootOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const start = lookup(rootOid);
  if (!start) return out;
  let treeOid = rootOid;
  if (start.type === 'commit') treeOid = parseCommit(start.data).tree;
  else if (start.type !== 'tree') return out;
  const walk = (tid: string, prefix: string): void => {
    const t = lookup(tid);
    if (!t || t.type !== 'tree') return;
    for (const e of parseTree(t.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build nested trees from a flat path map; returns root tree oid (stores objects via put). */
export function buildTreeFromFiles(flat: Map<string, { oid: string; mode: string }>, put: (type: GitObjectType, data: Buffer) => string): string {
  interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node>; }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, v] of [...flat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i]!;
      if (!node.dirs.has(s)) node.dirs.set(s, make());
      node = node.dirs.get(s)!;
    }
    node.files.set(segs[segs.length - 1]!, v);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, v] of node.files) entries.push({ mode: v.mode, name, oid: v.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

// -------------------------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error('pktline-too-long');
  // One allocation: header + payload in a single buffer instead of a concat.
  const out = Buffer.allocUnsafe(data.length + 4);
  out.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  data.copy(out, 4);
  return out;
}
// Flush/delim markers are immutable 4-byte constants shared by every response:
// they are only ever Buffer.concat'd, never written into.
const FLUSH_BUF = Buffer.from('0000', 'ascii');
const DELIM_BUF = Buffer.from('0001', 'ascii');
export const pktFlush = (): Buffer => FLUSH_BUF;
export const pktDelim = (): Buffer => DELIM_BUF;

export interface Pkt { kind: 'data' | 'flush' | 'delim' | 'response-end'; payload: Buffer; }
const EMPTY_BUF = Buffer.alloc(0);
/** Value of one hex digit, or -1 for a non-hex byte (avoids a string + regex per packet). */
export function hexVal(b: number): number {
  if (b >= 48 && b <= 57) return b - 48;
  if (b >= 97 && b <= 102) return b - 87;
  if (b >= 65 && b <= 70) return b - 55;
  return -1;
}
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('pktline-truncated');
    const h0 = hexVal(buf[off]!); const h1 = hexVal(buf[off + 1]!);
    const h2 = hexVal(buf[off + 2]!); const h3 = hexVal(buf[off + 3]!);
    if (h0 < 0 || h1 < 0 || h2 < 0 || h3 < 0) throw new Error(`pktline-header ${JSON.stringify(buf.subarray(off, off + 4).toString('ascii'))}`);
    const len = (h0 << 12) | (h1 << 8) | (h2 << 4) | h3;
    if (len === 0) { out.push({ kind: 'flush', payload: EMPTY_BUF }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: EMPTY_BUF }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end', payload: EMPTY_BUF }); off += 4; continue; }
    if (len < 4 || len > PKT_LINE_MAX) throw new Error('pktline-length');
    if (off + len > buf.length) throw new Error('pktline-truncated');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

// -------------------------------------------------------------------------------- packfile

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) { bytes.push(first | 0x80); first = remaining & 0x7f; remaining = Math.floor(remaining / 128); }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const o of list) {
    parts.push(writePackObjectHeader(o.type, o.data.length));
    // Level 1: the trial's timed clone workload is CPU-bound on pack compression;
    // any zlib level inflates identically, so trade size for speed.
    parts.push(deflateSync(o.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  // Compare digests as buffers instead of hex-encoding both sides first.
  const actual = pack.subarray(pack.length - 20);
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  return actual.equals(expected);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) { byte = buffer[offset++]!; value = ((value + 1) * 128) + (byte & 0x7f); }
  return { baseOffset: value, next: offset };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let value = 0; let shift = 0;
    for (;;) {
      const byte = delta[off++]!;
      value += (byte & 0x7f) * 2 ** shift; shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta-base-size');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++]!;
    if (op & 0x80) {
      let copyOffset = 0; let copySize = 0; let shift = 0;
      for (let bit = 0; bit < 4; bit++) { if (op & (1 << bit)) copyOffset += delta[off++]! * 2 ** shift; shift += 8; }
      shift = 0;
      for (let bit = 4; bit < 7; bit++) { if (op & (1 << bit)) copySize += delta[off++]! * 2 ** shift; shift += 8; }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const lit = op & 0x7f;
      delta.copy(out, written, off, off + lit);
      off += lit; written += lit;
    } else throw new Error('delta-opcode-0');
  }
  if (written !== targetSize) throw new Error('delta-size');
  return out;
}

export interface PackRead { objects: Map<string, GitObject>; deltaCount: number; version: number; count: number; }

/** Read a packfile, resolving OFS/REF deltas (bases may come from `resolveBase`). */
export function readPack(pack: Buffer, resolveBase?: ObjectLookup): PackRead {
  if (pack.length < 32) throw new Error('pack-truncated');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack-header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('pack-version');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  interface Raw { offset: number; typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string; resolved?: Buffer; resolvedType?: GitObjectType; oid?: string; }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset); offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex'); offset += 20;
    } else if (!CODE_TYPE[typeCode]) throw new Error('pack-type');
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.buffer.length !== header.size) throw new Error('pack-size');
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack-trailing');
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  let deltaCount = 0;
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error('pack-delta-cycle');
    resolving.add(entry.offset);
    let type: GitObjectType; let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('pack-delta-base');
      const base = resolve(baseEntry);
      type = base.type; data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) { const base = resolve(baseEntry); type = base.type; data = applyDelta(base.data, entry.data); }
      else {
        const ext = resolveBase?.(wanted);
        if (!ext) throw new Error('pack-delta-base');
        type = ext.type; data = applyDelta(ext.data, entry.data);
      }
    } else { type = CODE_TYPE[entry.typeCode]!; data = entry.data; }
    const oid = hashObject(type, data);
    entry.resolved = data; entry.resolvedType = type; entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const r = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount++;
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return { objects, deltaCount, version, count };
}
