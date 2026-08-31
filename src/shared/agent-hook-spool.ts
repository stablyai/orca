import { createHash } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'

export const AGENT_HOOK_SPOOL_MAX_BYTES = 5 * 1024 * 1024
export const AGENT_HOOK_SPOOL_MAX_FILES = 1024
export const AGENT_HOOK_SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export type SpoolRecord = {
  paneKey: string
  tabId?: string
  worktreeId?: string
  env?: string
  version?: string
  launchToken?: string
  hookEventName?: string
  source: string
  payload: unknown
  receivedAt: number
  [key: string]: unknown
}

/** Restore the HTTP listener body shape from a shell-written spool record. */
export function buildSpoolHookBody(record: SpoolRecord): Record<string, unknown> {
  return {
    paneKey: record.paneKey,
    tabId: record.tabId,
    worktreeId: record.worktreeId,
    env: record.env,
    version: record.version,
    launchToken: record.launchToken,
    hookEventName: record.hookEventName,
    payload: record.payload
  }
}

export function launchTokenHash(token: string | undefined): string | null {
  return token?.trim() ? createHash('sha256').update(token.trim()).digest('hex') : null
}

export function readSpoolRecords(path: string, now = Date.now()): SpoolRecord[] {
  return readSpoolFile(path, now).records
}

/** Records plus the byte offset through the last COMPLETE line. A torn trailing line is
 *  left unconsumed so a writer still finishing it is not truncated away. */
export function readSpoolFile(
  path: string,
  now = Date.now()
): { records: SpoolRecord[]; consumed: number } {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    return { records: [], consumed: 0 }
  }
  const records: SpoolRecord[] = []
  let consumed = 0
  let start = 0
  for (let end = 0; end <= bytes.length; end += 1) {
    if (end !== bytes.length && bytes[end] !== 0x0a) {
      continue
    }
    // A final line without its newline may still be in flight from a hook writer.
    // Leave it untouched until the writer terminates the record explicitly.
    if (end === bytes.length && (end === 0 || bytes[end - 1] !== 0x0a)) {
      break
    }
    const lineBytes = bytes.subarray(start, end)
    if (end !== bytes.length) {
      consumed = end + 1
    }
    start = end + 1
    if (lineBytes.length === 0) {
      continue
    }
    try {
      const value = JSON.parse(lineBytes.toString('utf8')) as Partial<SpoolRecord>
      if (
        typeof value.paneKey === 'string' &&
        typeof value.source === 'string' &&
        value.payload !== undefined &&
        typeof value.receivedAt === 'number' &&
        value.receivedAt >= now - AGENT_HOOK_SPOOL_MAX_AGE_MS
      ) {
        records.push(value as SpoolRecord)
      }
    } catch {
      // Torn lines are discarded while later complete lines remain replayable.
    }
  }
  return { records, consumed }
}

export type SpoolDrainOptions = {
  endpointDir: string
  getPersistedLaunchTokenHash: (paneKey: string) => string | undefined
  ingest: (record: SpoolRecord) => void
  now?: number
}

/** Drain JSONL files in place; never replace or unlink an inode held by a hook writer. */
export function drainAgentHookSpool(options: SpoolDrainOptions): number {
  const spoolDir = join(options.endpointDir, 'spool')
  let names: string[]
  try {
    names = readdirSync(spoolDir)
  } catch {
    return 0
  }
  const now = options.now ?? Date.now()
  const candidates = names
    .map((name) => {
      const path = join(spoolDir, name)
      try {
        const stat = statSync(path)
        // Empty files are retained to keep append handles race-safe, but they must not
        // consume the bounded replay candidate set ahead of files with durable events.
        return stat.isFile() && stat.size > 0 ? { path, mtimeMs: stat.mtimeMs } : null
      } catch {
        return null
      }
    })
    .filter((entry): entry is { path: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(0, AGENT_HOOK_SPOOL_MAX_FILES)
  let drained = 0
  for (const candidate of candidates) {
    const { records, consumed } = readSpoolFile(candidate.path, now)
    for (const record of records) {
      const expected = options.getPersistedLaunchTokenHash(record.paneKey)
      const actual = launchTokenHash(record.launchToken)
      if (expected && actual !== expected) {
        continue
      }
      options.ingest({ ...record, isReplay: true })
      drained += 1
    }
    try {
      const fd = openSync(candidate.path, 'r+')
      try {
        // Keep the inode so a concurrent append handle cannot silently orphan writes.
        const size = fstatSync(fd).size
        if (size > consumed) {
          // Why: a hook may have appended between the read and here; shift the unread tail
          // to the front instead of truncating to zero, which would erase it.
          const tail = Buffer.alloc(size - consumed)
          readSync(fd, tail, 0, tail.length, consumed)
          writeSync(fd, tail, 0, tail.length, 0)
          ftruncateSync(fd, tail.length)
        } else {
          ftruncateSync(fd, 0)
        }
      } finally {
        closeSync(fd)
      }
    } catch {
      // A concurrently removed or inaccessible file is harmless; the next launch retries it.
    }
  }
  return drained
}
