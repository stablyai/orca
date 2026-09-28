// Filesystem operations on one hook inbox directory: listing records in commit order, claiming a
// record by unlink, reading only complete records, and owning the directory privately.
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync
} from 'node:fs'
import { join } from 'node:path'

import {
  AGENT_HOOK_INBOX_MAX_PAYLOAD_CHARS,
  AGENT_HOOK_INBOX_RECORD_SUFFIX,
  endsWithAgentHookInboxRecordEnd
} from './agent-hook-inbox-record'

const MAX_RECORD_FILE_BYTES = AGENT_HOOK_INBOX_MAX_PAYLOAD_CHARS * 4 + 64 * 1024
const RECORD_TAIL_PROBE_BYTES = 32
const RECORD_NAME = /^(\d+)\.(\d+)\.rec$/

export type PendingRecord = {
  name: string
  path: string
  mtimeMs: number
  size: number
  pid: number
  seq: number
}

export function listPendingRecords(dir: string): PendingRecord[] {
  const pending: PendingRecord[] = []
  for (const name of listRecordNames(dir)) {
    const path = join(dir, name)
    try {
      const stat = lstatSync(path)
      if (!stat.isFile()) {
        continue
      }
      const match = RECORD_NAME.exec(name)
      pending.push({
        name,
        path,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        pid: match ? Number(match[1]) : 0,
        seq: match ? Number(match[2]) : 0
      })
    } catch {
      // Claimed or removed since the listing.
    }
  }
  // Why numeric pid/seq after mtime: coarse mtime clocks tie fast sequential hooks, and a
  // lexical sort would put pid 999 after pid 1000.
  return pending.sort((a, b) => a.mtimeMs - b.mtimeMs || a.pid - b.pid || a.seq - b.seq)
}

export function listRecordNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(AGENT_HOOK_INBOX_RECORD_SUFFIX))
  } catch {
    return []
  }
}

/** Only a successful unlink owns the record; ENOENT means another drain took it, and EPERM/EBUSY
 *  (Windows scanners holding the file) means try again on the next pass. */
export function claim(path: string): boolean {
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

export function readCompleteRecord(path: string): Buffer | 'incomplete' | 'invalid' {
  let fd: number
  try {
    // Why O_NOFOLLOW: the inbox is private, but a record must never read through a link.
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  } catch {
    return 'incomplete'
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_RECORD_FILE_BYTES) {
      return 'invalid'
    }
    // Why probe the tail first: a record still being written is common under load, and reading
    // a large unfinished payload on every wake would be wasted work.
    const tailLength = Math.min(stat.size, RECORD_TAIL_PROBE_BYTES)
    const tail = Buffer.alloc(tailLength)
    readSync(fd, tail, 0, tailLength, stat.size - tailLength)
    if (!endsWithAgentHookInboxRecordEnd(tail)) {
      return 'incomplete'
    }
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (read === 0) {
        return 'incomplete'
      }
      offset += read
    }
    return bytes
  } catch {
    return 'incomplete'
  } finally {
    closeSync(fd)
  }
}

export function ensurePrivateDirectory(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dir)
    if (!stat.isDirectory()) {
      return false
    }
    if (process.platform === 'win32') {
      return true
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      return false
    }
    if ((stat.mode & 0o077) !== 0) {
      chmodSync(dir, 0o700)
    }
    return true
  } catch {
    return false
  }
}
