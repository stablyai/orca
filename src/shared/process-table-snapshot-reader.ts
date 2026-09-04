import { execFile as execFileCb } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import {
  PS_ARGS,
  PS_MAX_BUFFER_BYTES,
  ProcessTableCaptureError,
  parseProcessTableRows,
  parseStrictProcessTableRows,
  type ProcessTableRow
} from './process-table-snapshot'

export { PS_ARGS, PS_MAX_BUFFER_BYTES }

const execFile = promisify(execFileCb)

/** Columns used by the evidence reader. Keep command last so its spaces survive parsing. */
export const PS_TIMEOUT_MS = 3000
const DEFAULT_SNAPSHOT_TTL_MS = 500

type Snapshot<T> = { value: T; capturedAtMs: number }

type ProcessTableSnapshotReaderDeps<T> = {
  runPs: () => Promise<T>
  now: () => number
  ttlMs?: number
}

/** Build a process-table reader that coalesces concurrent and recent captures. */
export function createProcessTableSnapshotReader<T = string>(
  deps: ProcessTableSnapshotReaderDeps<T>
): {
  getSnapshot: () => Promise<T>
  getSnapshotWithAge: () => Promise<{ value: T; capturedAgeMs: number }>
  getFreshSnapshot: () => Promise<T>
  reset: () => void
} {
  const ttlMs = deps.ttlMs ?? DEFAULT_SNAPSHOT_TTL_MS
  let cached: Snapshot<T> | null = null
  let inFlight: Promise<T> | null = null
  let sequence = 0
  let freshQueued: { promise: Promise<T>; startSequence: number | null } | null = null

  async function runSnapshot(): Promise<T> {
    const promise = deps.runPs()
    inFlight = promise
    try {
      const value = await promise
      cached = { value, capturedAtMs: deps.now() }
      return value
    } finally {
      if (inFlight === promise) {
        inFlight = null
      }
    }
  }

  async function getSnapshot(): Promise<T> {
    if (cached && deps.now() - cached.capturedAtMs < ttlMs) {
      return cached.value
    }
    if (inFlight) {
      return inFlight
    }
    if (freshQueued) {
      return freshQueued.promise
    }
    return runSnapshot()
  }

  async function getSnapshotWithAge(): Promise<{ value: T; capturedAgeMs: number }> {
    const value = await getSnapshot()
    const capturedAtMs = cached?.value === value ? cached.capturedAtMs : deps.now()
    return { value, capturedAgeMs: Math.max(0, deps.now() - capturedAtMs) }
  }

  function getFreshSnapshot(): Promise<T> {
    const requestSequence = ++sequence
    if (freshQueued?.startSequence === null) {
      return freshQueued.promise
    }
    const priorFresh = freshQueued?.promise ?? null
    const priorScan = inFlight
    const entry: { promise: Promise<T>; startSequence: number | null } = {
      promise: Promise.resolve(undefined as never),
      startSequence: null
    }
    entry.promise = Promise.resolve().then(async () => {
      for (const prior of [priorFresh, priorScan]) {
        if (!prior) {
          continue
        }
        try {
          await prior
        } catch {
          // The post-boundary scan below owns the confirmation result.
        }
      }
      entry.startSequence = ++sequence
      if (entry.startSequence <= requestSequence) {
        throw new Error('fresh process snapshot did not start after request')
      }
      return runSnapshot()
    })
    freshQueued = entry
    const clearQueued = (): void => {
      if (freshQueued === entry) {
        freshQueued = null
      }
    }
    void entry.promise.then(clearQueued, clearQueued)
    return entry.promise
  }

  return {
    getSnapshot,
    getSnapshotWithAge,
    getFreshSnapshot,
    reset: () => {
      cached = null
      inFlight = null
      sequence = 0
      freshQueued = null
    }
  }
}

type ProcessTableCapture = {
  lenient: () => ProcessTableRow[]
  strict: () => ProcessTableRow[]
}

function applyProcessStartTimes(
  rows: ProcessTableRow[],
  startTimesByPid: ReadonlyMap<number, string> | undefined,
  dropUnstableStartTimes = false
): ProcessTableRow[] {
  if ((!startTimesByPid || startTimesByPid.size === 0) && !dropUnstableStartTimes) {
    return rows
  }
  return rows.map((row) => {
    const startTime = startTimesByPid?.get(row.pid)
    if (startTime) {
      return { ...row, startTime }
    }
    if (dropUnstableStartTimes && row.startTime !== undefined) {
      const { startTime: _unstable, ...withoutStartTime } = row
      return withoutStartTime
    }
    return row
  })
}

function createProcessTableCapture(
  stdout: string,
  startTimesByPid?: ReadonlyMap<number, string>,
  dropUnstableStartTimes = false
): ProcessTableCapture {
  let lenientRows: ProcessTableRow[] | null = null
  let strictResult: { rows: ProcessTableRow[] } | { error: unknown } | null = null
  return {
    lenient: () =>
      (lenientRows ??= applyProcessStartTimes(
        parseProcessTableRows(stdout),
        startTimesByPid,
        dropUnstableStartTimes
      )),
    strict: () => {
      if (strictResult === null) {
        try {
          strictResult = {
            rows: applyProcessStartTimes(
              parseStrictProcessTableRows(stdout),
              startTimesByPid,
              dropUnstableStartTimes
            )
          }
        } catch (error) {
          strictResult = { error }
        }
      }
      if ('error' in strictResult) {
        throw strictResult.error
      }
      return strictResult.rows
    }
  }
}

/** Reject captures truncated at the subprocess ceiling or containing no rows. */
function assertWholeCapture(stdout: string): string {
  if (Buffer.byteLength(stdout, 'utf-8') >= PS_MAX_BUFFER_BYTES) {
    throw new ProcessTableCaptureError('capture_truncated')
  }
  if (!/\S/.test(stdout)) {
    throw new ProcessTableCaptureError('empty_capture')
  }
  return stdout
}

/** Read Linux's stable PID start-time ticks without spawning another process. */
async function readLinuxProcessStartTimes(
  rows: readonly ProcessTableRow[]
): Promise<ReadonlyMap<number, string> | undefined> {
  if (process.platform !== 'linux') {
    return undefined
  }
  const candidates = rows.filter((row) => row.tty !== undefined && row.tty !== '?')
  const starts = await Promise.all(
    candidates.map(async (row) => {
      try {
        const stat = await readFile(`/proc/${row.pid}/stat`, 'utf8')
        const closingParen = stat.lastIndexOf(')')
        if (closingParen === -1) {
          return null
        }
        const tail = stat
          .slice(closingParen + 1)
          .trim()
          .split(/\s+/)
        const startTime = tail[19]
        return startTime ? ([row.pid, startTime] as const) : null
      } catch {
        return null
      }
    })
  )
  const result = new Map<number, string>()
  for (const entry of starts) {
    if (entry) {
      result.set(entry[0], entry[1])
    }
  }
  return result
}

const processTableReader = createProcessTableSnapshotReader<ProcessTableCapture>({
  runPs: async () => {
    let stdout: string
    try {
      ;({ stdout } = await execFile('ps', [...PS_ARGS], {
        encoding: 'utf-8',
        timeout: PS_TIMEOUT_MS,
        maxBuffer: PS_MAX_BUFFER_BYTES
      }))
    } catch (error) {
      // A ceiling hit is truncation, not absence: name it in the domain vocabulary.
      if ((error as { code?: unknown } | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        throw new ProcessTableCaptureError('capture_truncated')
      }
      throw error
    }
    const baseCapture = createProcessTableCapture(assertWholeCapture(stdout))
    const startTimesByPid = await readLinuxProcessStartTimes(baseCapture.lenient())
    return createProcessTableCapture(stdout, startTimesByPid, process.platform === 'linux')
  },
  now: () => Date.now()
})

export async function getProcessTableSnapshot(): Promise<ProcessTableRow[]> {
  return (await processTableReader.getSnapshot()).lenient()
}

export async function getFreshProcessTableSnapshot(): Promise<ProcessTableRow[]> {
  return (await processTableReader.getFreshSnapshot()).lenient()
}

export async function getStrictProcessTableSnapshot(): Promise<ProcessTableRow[]> {
  return (await processTableReader.getSnapshot()).strict()
}

export async function getStrictProcessTableSnapshotWithAge(): Promise<{
  rows: ProcessTableRow[]
  capturedAgeMs: number
}> {
  const snapshot = await processTableReader.getSnapshotWithAge()
  return { rows: snapshot.value.strict(), capturedAgeMs: snapshot.capturedAgeMs }
}

/** How much older than its own await a TTL-cached capture may be. */
export const PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS = DEFAULT_SNAPSHOT_TTL_MS

export function resetProcessTableSnapshotForTests(): void {
  processTableReader.reset()
}
