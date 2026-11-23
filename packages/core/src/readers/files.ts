// SPDX-License-Identifier: Apache-2.0
// Reading the ends of large files, JSON lines, and recent files under a root.
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";

/** The first and last bytes of a file, as lines — a transcript can be tens of MB. */
export function ends(file: string, headBytes: number, tailBytes: number): { head: string[]; tail: string[] } {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const read = (pos: number, len: number) => {
      const b = Buffer.alloc(len);
      const n = readSync(fd as number, b, 0, len, pos);
      return b.subarray(0, n).toString("utf8");
    };
    const head = read(0, Math.min(size, headBytes));
    const tail = size > headBytes ? read(Math.max(0, size - tailBytes), Math.min(size, tailBytes)) : head;
    return { head: head.split("\n").slice(0, -1), tail: tail.split("\n").slice(size > headBytes ? 1 : 0) };
  } catch {
    return { head: [], tail: [] };
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {}
  }
}

export const parseLines = (lines: string[]): Record<string, unknown>[] =>
  lines
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, unknown> => !!x);

/** Read line by line up to `cap` bytes, stopping when `visit` returns a value. */
export function scanLines<T>(file: string, visit: (line: string) => T | null, cap = 16 * 1024 * 1024): T | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(1024 * 1024);
    let pos = 0;
    let rest: Buffer = Buffer.alloc(0);
    while (pos < cap) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      pos += n;
      let chunk = Buffer.concat([rest, buf.subarray(0, n)]);
      let nl = chunk.indexOf(10);
      while (nl >= 0) {
        const r = visit(chunk.subarray(0, nl).toString("utf8"));
        if (r !== null) return r;
        chunk = chunk.subarray(nl + 1);
        nl = chunk.indexOf(10);
      }
      rest = chunk;
    }
  } catch {
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {}
  }
  return null;
}

export function recentFiles(root: string, depth: number, sinceMs: number, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string, d: number) => {
    let names: import("node:fs").Dirent[] = [];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (d < depth) walk(p, d + 1);
        continue;
      }
      if (!match(e.name)) continue;
      try {
        if (statSync(p).mtimeMs >= sinceMs) out.push(p);
      } catch {}
    }
  };
  walk(root, 0);
  return out;
}

const GUARD_BYTES = 64;
const TAIL_READ_CHUNK = 256 * 1024;
const MAX_TAIL_CACHE_FILES = 32;
const EMPTY_BUF = Buffer.alloc(0);

interface TailCacheEntry {
  dev: number;
  ino: number;
  /** Byte offset immediately after the last committed `\n` (`0x0a`) in `lines`. */
  byteOffset: number;
  /** Number of committed newline-terminated lines in `lines` (`0 .. completeCount - 1`). */
  completeCount: number;
  /** Equivalent to `readFileSync(file, "utf8").split("\n")`: committed lines + 1 trailing element. */
  lines: string[];
  /** Prefix guard bytes `[0 .. min(GUARD_BYTES, byteOffset))` to detect in-place overwrites on the same inode. */
  headGuard: Buffer;
  /** Suffix guard bytes `[byteOffset - min(GUARD_BYTES, byteOffset) .. byteOffset)` to detect rewrites. */
  tailGuard: Buffer;
}

function readSlice(fd: number, pos: number, len: number): Buffer {
  const buf = Buffer.allocUnsafe(len);
  return buf.subarray(0, readSync(fd, buf, 0, len, pos));
}

/** Incremental `(filePath, dev, ino, byteOffset)` JSONL line reader. Repeated reads of
 *  the same growing transcript during settle polling read only newly appended bytes from
 *  `byteOffset` while resetting cleanly to byte 0 on truncation, inode rotation, or
 *  in-place file rewrite. */
export class TranscriptTailReader {
  private readonly cache = new Map<string, TailCacheEntry>();

  constructor(private readonly maxFiles = MAX_TAIL_CACHE_FILES) {}

  clear(): void {
    this.cache.clear();
  }

  read(file: string): string[] | null {
    let fd: number | undefined;
    try {
      fd = openSync(file, "r");
      const st = fstatSync(fd);
      if (!st.isFile()) {
        this.cache.delete(file);
        return null;
      }
      const size = st.size;
      let entry = this.cache.get(file);
      if (entry) {
        const sameIdentity = entry.dev === st.dev && entry.ino === st.ino && size >= entry.byteOffset;
        let guardsMatch = sameIdentity;
        if (guardsMatch && entry.byteOffset > 0) {
          guardsMatch = readSlice(fd, 0, entry.headGuard.length).equals(entry.headGuard);
          if (guardsMatch && entry.byteOffset > entry.headGuard.length) {
            guardsMatch = readSlice(fd, entry.byteOffset - entry.tailGuard.length, entry.tailGuard.length).equals(
              entry.tailGuard,
            );
          }
        }
        if (!guardsMatch) entry = undefined;
      }
      if (!entry) {
        entry = {
          dev: st.dev,
          ino: st.ino,
          byteOffset: 0,
          completeCount: 0,
          lines: [""],
          headGuard: EMPTY_BUF,
          tailGuard: EMPTY_BUF,
        };
      }
      if (size === 0 || size === entry.byteOffset) {
        entry.lines.length = entry.completeCount;
        entry.lines.push("");
        this.touch(file, entry);
        return entry.lines;
      }

      const prevByteOffset = entry.byteOffset;
      entry.lines.length = entry.completeCount;
      let pos = entry.byteOffset;
      const chunkBuf = Buffer.allocUnsafe(Math.min(TAIL_READ_CHUNK, size - pos));
      let rem: Buffer = EMPTY_BUF;
      while (true) {
        const n = readSync(fd, chunkBuf, 0, chunkBuf.length, pos);
        if (!n) break;
        const sub = chunkBuf.subarray(0, n);
        let start = 0;
        while (true) {
          const nl = sub.indexOf(0x0a, start);
          if (nl < 0) break;
          const part = sub.subarray(start, nl);
          const line = rem.length ? Buffer.concat([rem, part]).toString("utf8") : sub.toString("utf8", start, nl);
          rem = EMPTY_BUF;
          entry.lines.push(line);
          entry.completeCount++;
          entry.byteOffset = pos + nl + 1;
          start = nl + 1;
        }
        if (start < sub.length) {
          const tail = sub.subarray(start);
          rem = rem.length ? Buffer.concat([rem, tail]) : Buffer.from(tail);
        }
        pos += n;
      }
      if (entry.byteOffset > prevByteOffset) {
        const headWant = Math.min(GUARD_BYTES, entry.byteOffset);
        if (entry.headGuard.length < headWant) entry.headGuard = readSlice(fd, 0, headWant);
        const tailWant = Math.min(GUARD_BYTES, entry.byteOffset);
        entry.tailGuard = readSlice(fd, entry.byteOffset - tailWant, tailWant);
      }
      entry.lines.push(rem.length ? rem.toString("utf8") : "");
      this.touch(file, entry);
      return entry.lines;
    } catch {
      this.cache.delete(file);
      return null;
    } finally {
      if (fd !== undefined)
        try {
          closeSync(fd);
        } catch {}
    }
  }

  private touch(file: string, entry: TailCacheEntry): void {
    this.cache.delete(file);
    this.cache.set(file, entry);
    while (this.cache.size > this.maxFiles) {
      this.cache.delete(this.cache.keys().next().value as string);
    }
  }
}

const defaultTailReader = new TranscriptTailReader();

/** Read a JSONL transcript file into lines incrementally from the cached byte cursor. */
export function readTranscriptLines(file: string): string[] | null {
  return defaultTailReader.read(file);
}
