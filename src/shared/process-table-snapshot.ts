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
 * scan result so the Windows path can cache parsed rows while POSIX caches the
 * raw `ps` stdout string (the default).
 */
export function createProcessTableSnapshotReader<T = string>(
  deps: ProcessTableSnapshotReaderDeps<T>
): {
  getSnapshot: () => Promise<T>
  reset: () => void
} {
  const ttlMs = deps.ttlMs ?? DEFAULT_SNAPSHOT_TTL_MS
  let cached: Snapshot<T> | null = null
  let inFlight: Promise<T> | null = null

  async function getSnapshot(): Promise<T> {
    if (cached && deps.now() - cached.capturedAtMs < ttlMs) {
      return cached.value
    }
    if (inFlight) {
      return inFlight
    }
    const promise = deps.runPs()
    inFlight = promise
    try {
      const value = await promise
      // Why: stamp capture time AFTER the scan returns so a slow scan can't
      // hand back a snapshot that is already older than its TTL.
      cached = { value, capturedAtMs: deps.now() }
      return value
    } finally {
      // Clear in-flight on success and failure so a transient `ps` error
      // (timeout, nonzero exit) retries on the next call instead of being
      // cached; callers keep their existing best-effort fall-through.
      if (inFlight === promise) {
        inFlight = null
      }
    }
  }

  return {
    getSnapshot,
    // Why: lets tests that mock `ps` per case clear the cross-call cache so one
    // case's snapshot can't satisfy the next within the TTL window.
    reset: () => {
      cached = null
      inFlight = null
    }
  }
}

const defaultReader = createProcessTableSnapshotReader({
  runPs: async () => {
    const { stdout } = await execFile('ps', [...PS_ARGS], {
      encoding: 'utf-8',
      timeout: PS_TIMEOUT_MS
    })
    return stdout
  },
  now: () => Date.now()
})

/**
 * Run (or reuse a recent) `ps -axo pid=,ppid=,stat=,command=` scan and return
 * its raw stdout. Per-process singleton: the relay and local main processes
 * each dedupe their own scans.
 */
export function getProcessTableSnapshot(): Promise<string> {
  return defaultReader.getSnapshot()
}

/**
 * Test-only: clear the shared snapshot cache so suites that mock `ps` between
 * cases don't have one case's snapshot served to the next within the TTL.
 */
export function resetProcessTableSnapshotForTests(): void {
  defaultReader.reset()
}
