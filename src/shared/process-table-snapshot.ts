import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

// Why: agent foreground-process inspection runs this full process-table scan on
// a 750ms/2000ms per-pane cadence. On a shared SSH relay every tracked agent
// terminal drives it, so concurrent panes used to each fork their own `ps`,
// pinning idle CPU (issue #6288). Memoizing collapses overlapping scans to one.
const PS_ARGS = ['-axo', 'pid=,ppid=,stat=,command='] as const
const PS_TIMEOUT_MS = 3000

// Why: 500ms is below the active cadence poll's minimum inter-poll gap (~675ms
// = 750ms less jitter), so a cadence-driven pane never reuses a snapshot older
// than it would have scanned itself; a burst of panes polling in the same
// window collapses from up to 8 scans/sec down to ~2/sec. The faster
// event-driven follow-up inspections (e.g. the pending-title confirmation,
// which can re-fire <500ms apart) intentionally accept a <=500ms-stale table:
// they only confirm the same agent still owns the pane, and process-exit is
// debounced across repeated samples, so a near-instant cached scan answers
// identically to a fresh fork.
const DEFAULT_SNAPSHOT_TTL_MS = 500

export type ProcessTableRow = {
  pid: number
  ppid: number
  stat: string
  command: string
}

/**
 * Parse `ps -axo pid=,ppid=,stat=,command=` output into rows. Tolerates CRLF so
 * a snapshot parsed on any host stays correct; `command` (last field) keeps its
 * internal spaces because the regex is anchored and greedy on the tail.
 */
export function parseProcessTableRows(stdout: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
    if (!match) {
      continue
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      stat: match[3],
      command: match[4]
    })
  }
  return rows
}

type Snapshot<T> = { value: T; capturedAtMs: number }

type ProcessTableSnapshotReaderDeps<T> = {
  runPs: () => Promise<T>
  now: () => number
  ttlMs?: number
}

/**
 * Build a process-table snapshot reader that deduplicates concurrent and
 * near-simultaneous scans behind a single in-flight promise + short TTL.
 * Exposed as a factory so tests can inject the scan and clock; production code
 * uses the shared `getProcessTableSnapshot` instance below. Generic over the
 * scan result so both the POSIX and Windows readers cache already-parsed rows,
 * letting a burst of panes share one parse per TTL window.
 */
export function createProcessTableSnapshotReader<T = string>(
  deps: ProcessTableSnapshotReaderDeps<T>
): {
  getSnapshot: () => Promise<T>
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
      // Why: stamp capture time AFTER the scan returns so a slow scan can't
      // hand back a snapshot that is already older than its TTL.
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
      // Why: a fresh request schedules its scan in a microtask so same-turn
      // callers can share it; an ordinary miss must not start a competing scan.
      return freshQueued.promise
    }
    return runSnapshot()
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
      // Why: same-turn callers join while startSequence is null; later callers
      // queue behind this scan. The sequence proves every shared scan began
      // strictly after each request without relying on wall-clock precision.
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
    getFreshSnapshot,
    // Why: lets tests that mock `ps` per case clear the cross-call cache so one
    // case's snapshot can't satisfy the next within the TTL window.
    reset: () => {
      cached = null
      inFlight = null
      sequence = 0
      freshQueued = null
    }
  }
}

const defaultReader = createProcessTableSnapshotReader<ProcessTableRow[]>({
  runPs: async () => {
    const { stdout } = await execFile('ps', [...PS_ARGS], {
      encoding: 'utf-8',
      timeout: PS_TIMEOUT_MS
    })
    // Why: parse once inside the deduped scan so a burst of panes sharing the
    // TTL window reuse one ProcessTableRow[] instead of each re-tokenizing the
    // identical stdout — matches the Windows reader, which already caches rows.
    return parseProcessTableRows(stdout)
  },
  now: () => Date.now()
})

/**
 * Run (or reuse a recent) `ps -axo pid=,ppid=,stat=,command=` scan and return
 * its parsed rows. Per-process singleton: the relay and local main processes
 * each dedupe their own scans and share a single parse per TTL window.
 */
export function getProcessTableSnapshot(): Promise<ProcessTableRow[]> {
  return defaultReader.getSnapshot()
}

/** Capture process rows from a scan that starts after this request. */
export function getFreshProcessTableSnapshot(): Promise<ProcessTableRow[]> {
  return defaultReader.getFreshSnapshot()
}

/**
 * Test-only: clear the shared snapshot cache so suites that mock `ps` between
 * cases don't have one case's snapshot served to the next within the TTL.
 */
export function resetProcessTableSnapshotForTests(): void {
  defaultReader.reset()
}
