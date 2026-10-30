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
    agentProcess: record.agentProcess,
    opencodeMajor: record.opencodeMajor,
    opencodeTui: record.opencodeTui,
    opencodeSharedServer: record.opencodeSharedServer,
    payload: record.payload
  }
}

export function launchTokenHash(token: string | undefined): string | null {
  return token?.trim() ? createHash('sha256').update(token.trim()).digest('hex') : null
}

/** Consume through complete newlines only; a writer may still be finishing the trailing record. */
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
  // Native indexOf avoids an interpreted byte scan during startup replay.
  for (;;) {
    const end = bytes.indexOf(0x0a, start)
    // Leave a partial trailing record for its append writer.
    if (end === -1) {
      break
    }
    const lineBytes = bytes.subarray(start, end)
    consumed = end + 1
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
  ingest: (record: SpoolRecord) => Promise<void> | void
  now?: number
}

/** Drain JSONL files in place; never replace or unlink an inode held by a hook writer. */
function spoolCandidates(endpointDir: string): { path: string; mtimeMs: number }[] {
  const spoolDir = join(endpointDir, 'spool')
  let names: string[]
  try {
    names = readdirSync(spoolDir)
  } catch {
    return []
  }
  return names
    .map((name) => {
      const path = join(spoolDir, name)
      try {
        const stat = statSync(path)
        // Retain empty files for append handles but exclude them from the bounded replay candidate set.
        return stat.isFile() && stat.size > 0 ? { path, mtimeMs: stat.mtimeMs } : null
      } catch {
        return null
      }
    })
    .filter((entry): entry is { path: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(0, AGENT_HOOK_SPOOL_MAX_FILES)
}

function consumeSpoolPrefix(path: string, consumed: number): void {
  try {
    const fd = openSync(path, 'r+')
    try {
      // Keep the inode so a concurrent append handle cannot silently orphan writes.
      const size = fstatSync(fd).size
      if (size > consumed) {
        // Preserve appends made since the read by shifting the unread tail before truncation.
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

function matchesLaunchToken(
  record: SpoolRecord,
  options: Pick<SpoolDrainOptions, 'getPersistedLaunchTokenHash'>
): boolean {
  const expected = options.getPersistedLaunchTokenHash(record.paneKey)
  return !expected || launchTokenHash(record.launchToken) === expected
}

/** Await each admission before consuming a file so owner probes preserve replay order and retry. */
export async function drainAgentHookSpoolAsync(options: SpoolDrainOptions): Promise<number> {
  const now = options.now ?? Date.now()
  let drained = 0
  for (const candidate of spoolCandidates(options.endpointDir)) {
    const { records, consumed } = readSpoolFile(candidate.path, now)
    for (const record of records) {
      if (matchesLaunchToken(record, options)) {
        await options.ingest({ ...record, isReplay: true })
        drained += 1
      }
    }
    consumeSpoolPrefix(candidate.path, consumed)
  }
  return drained
}
