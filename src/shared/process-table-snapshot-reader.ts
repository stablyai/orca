import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readLinuxProcessStartTimes } from './linux-process-start-times'
import { withEvidenceBudget } from './process-table-evidence-budget'
import {
  PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS,
  PS_ARGS,
  PS_MAX_BUFFER_BYTES,
  ProcessTableCaptureError,
  parseProcessTableRows,
  parseStrictProcessTableRows,
  type ProcessTableRow
} from './process-table-snapshot'

export { parseLinuxProcStatStartTime } from './linux-process-start-times'
export {
  PROCESS_TABLE_EVIDENCE_BUDGET_MS,
  withEvidenceBudget
} from './process-table-evidence-budget'
export { PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS, PS_ARGS, PS_MAX_BUFFER_BYTES }

const execFile = promisify(execFileCb)

// Why 15s: the `command=` column costs a per-pid argv read (measured 1.15s for 1,948
// processes; 0.03s without it), and CPU contention multiplies that -- at load 27 the same
// capture measured 1.3-6.0s, so a 3s budget timed out on 6 of 20 consecutive tries and the
// whole subsystem answered "unverifiable" about a table it could read. This keeps a wedged
// `ps` bounded while staying out of reach of a host that is merely busy.
export const PS_TIMEOUT_MS = 15_000
const DEFAULT_SNAPSHOT_TTL_MS = PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS

type Snapshot<T> = { value: T; capturedAtMs: number; completedAtMs: number }

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
    // Two stamps because they answer different questions: `capturedAtMs` is when `ps` read the
    // kernel table, which is what a destructive consumer bounds staleness against, while the TTL
    // keys on completion so a capture slower than the TTL still coalesces instead of forking a
    // whole-machine `ps` per caller on exactly the loaded host that can least afford it.
    const capturedAtMs = deps.now()
    const promise = deps.runPs()
    inFlight = promise
    try {
      const value = await promise
      cached = { value, capturedAtMs, completedAtMs: deps.now() }
      return value
    } finally {
      if (inFlight === promise) {
        inFlight = null
      }
    }
  }

  async function getSnapshot(): Promise<T> {
    if (cached && deps.now() - cached.completedAtMs < ttlMs) {
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

async function captureProcessTable(args: readonly string[]): Promise<ProcessTableCapture> {
  let stdout: string
  try {
    ;({ stdout } = await execFile('ps', [...args], {
      encoding: 'utf-8',
      timeout: PS_TIMEOUT_MS,
      maxBuffer: PS_MAX_BUFFER_BYTES
    }))
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new ProcessTableCaptureError('capture_truncated')
    }
    throw error
  }
  const baseCapture = createProcessTableCapture(assertWholeCapture(stdout))
  const startTimesByPid = await readLinuxProcessStartTimes(baseCapture.lenient())
  return createProcessTableCapture(stdout, startTimesByPid, process.platform === 'linux')
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

const processTableReader = createProcessTableSnapshotReader<ProcessTableCapture>({
  runPs: () => captureProcessTable(PS_ARGS),
  now: () => Date.now()
})

export async function getProcessTableSnapshot(): Promise<ProcessTableRow[]> {
  return (await processTableReader.getSnapshot()).lenient()
}

export async function getFreshProcessTableSnapshot(): Promise<ProcessTableRow[]> {
  return (await processTableReader.getFreshSnapshot()).lenient()
}

/** Fresh POSIX process evidence scoped to one PTY instead of the whole host. */
export async function getFreshPtyProcessTableSnapshot(rootPid: number): Promise<ProcessTableRow[]> {
  if (process.platform === 'win32') {
    return getFreshProcessTableSnapshot()
  }
  const rootRows = (
    await captureProcessTable(['-p', String(rootPid), '-o', PS_ARGS[1] ?? ''])
  ).strict()
  const root = rootRows.find((row) => row.pid === rootPid)
  if (!root?.tty || root.tty === '?' || root.tty === '??' || root.tty === '-') {
    return getFreshProcessTableSnapshot()
  }
  const ttyRows = (await captureProcessTable(['-t', root.tty, '-o', PS_ARGS[1] ?? ''])).strict()
  const currentRoot = ttyRows.find((row) => row.pid === rootPid)
  if (
    !root.startTime ||
    !currentRoot?.startTime ||
    currentRoot.startTime !== root.startTime ||
    currentRoot.tty !== root.tty
  ) {
    throw new ProcessTableCaptureError('pty_root_changed')
  }
  return ttyRows
}

export async function getStrictProcessTableSnapshot(): Promise<ProcessTableRow[]> {
  return (await processTableReader.getSnapshot()).strict()
}

export async function getStrictProcessTableSnapshotWithAge(): Promise<{
  rows: ProcessTableRow[]
  capturedAgeMs: number
}> {
  const snapshot = await withEvidenceBudget(processTableReader.getSnapshotWithAge())
  return { rows: snapshot.value.strict(), capturedAgeMs: snapshot.capturedAgeMs }
}

export function resetProcessTableSnapshotForTests(): void {
  processTableReader.reset()
}
