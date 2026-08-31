import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

// Why: agent foreground-process inspection runs this full process-table scan on
// a 750ms/2000ms per-pane cadence. On a shared SSH relay every tracked agent
// terminal drives it, so concurrent panes used to each fork their own `ps`,
// pinning idle CPU (issue #6288). Memoizing collapses overlapping scans to one.
/** Columns used by the evidence reader. Keep command last so its spaces survive parsing. */
export const PS_ARGS = ['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,command='] as const
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
  /** Process group id. Optional only on rows produced by the legacy parser input shape. */
  pgid?: number
  /** Terminal foreground process group id (`0`/`-1` means no controlling tty). */
  tpgid?: number
  stat: string
  command: string
}

/**
 * Parse legacy or evidence-shaped `ps` output into rows. Tolerates CRLF so a
 * snapshot parsed on any host stays correct; `command` (last field) keeps its
 * internal spaces because the regex is anchored and greedy on the tail.
 */
export function parseProcessTableRows(stdout: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(?:(-?\d+)\s+(-?\d+)\s+)?(\S+)\s+(.+)$/)
    if (!match) {
      continue
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      ...(match[3] !== undefined ? { pgid: Number(match[3]), tpgid: Number(match[4]) } : {}),
      stat: match[5] ?? match[3],
      command: match[6] ?? match[4]
    } as ProcessTableRow)
  }
  return rows
}

export class ProcessTableCaptureError extends Error {
  readonly code = 'process_table_unreadable'

  constructor(readonly reason: string) {
    super(`process table unreadable: ${reason}`)
    this.name = 'ProcessTableCaptureError'
  }
}

/**
 * Parse a process-table capture for identity evidence. Unlike the historical
 * parser above, every non-framing line must be valid: silently dropping one row
 * could turn a truncated table into a false empty/no-agent result.
 *
 * Linux kernel roots legitimately report `ppid=0`, `pgid=0`, and
 * `tpgid=-1`; user-space processes can also report `tpgid=0`/`-1` when no
 * controlling TTY is attached. The parser therefore rejects only values
 * outside the process-table domain (`pid <= 0`, `ppid < 0`, `pgid < 0`, or
 * `tpgid < -1`), while retaining strict row framing and non-empty fields;
 * an empty/header-only capture is unreadable as well.
 */
export function parseStrictProcessTableRows(stdout: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }
    if (/^PID\s+PPID\s+PGID\s+TPGID\s+STAT\s+COMMAND$/i.test(line)) {
      continue
    }
    const match = line.match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(.+)$/)
    if (!match) {
      throw new ProcessTableCaptureError('malformed_row')
    }
    const pid = Number(match[1])
    const ppid = Number(match[2])
    const pgid = Number(match[3])
    const tpgid = Number(match[4])
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(ppid) ||
      ppid < 0 ||
      !Number.isSafeInteger(pgid) ||
      pgid < 0 ||
      !Number.isSafeInteger(tpgid) ||
      (tpgid < 0 && tpgid !== -1) ||
      match[6].length === 0
    ) {
      throw new ProcessTableCaptureError('invalid_numeric_field')
    }
    rows.push({ pid, ppid, pgid, tpgid, stat: match[5], command: match[6] })
  }
  if (rows.length === 0) {
    throw new ProcessTableCaptureError('empty_capture')
  }
  return rows
}

/** Alias retained for callers that prefer the adjective at the end. */
export const parseProcessTableRowsStrict = parseStrictProcessTableRows

export type ProcessTableIndexStats = {
  captures?: number
  indexBuilds: number
  rowVisits: number
  indexLookups: number
}

export type ProcessTableIndex = {
  rows: readonly ProcessTableRow[]
  byPid: ReadonlyMap<number, ProcessTableRow>
  childrenByPpid: ReadonlyMap<number, readonly ProcessTableRow[]>
  byPgid: ReadonlyMap<number, readonly ProcessTableRow[]>
  byTpgid: ReadonlyMap<number, readonly ProcessTableRow[]>
  stats?: ProcessTableIndexStats
}

/** Build all correlation indexes in one linear pass over a capture. */
export function buildProcessTableIndex(
  rows: readonly ProcessTableRow[],
  stats?: ProcessTableIndexStats
): ProcessTableIndex {
  if (stats) {
    stats.indexBuilds += 1
  }
  const byPid = new Map<number, ProcessTableRow>()
  const childrenByPpid = new Map<number, ProcessTableRow[]>()
  const byPgid = new Map<number, ProcessTableRow[]>()
  const byTpgid = new Map<number, ProcessTableRow[]>()
  for (const row of rows) {
    if (stats) {
      stats.rowVisits += 1
    }
    byPid.set(row.pid, row)
    const children = childrenByPpid.get(row.ppid) ?? []
    children.push(row)
    childrenByPpid.set(row.ppid, children)
    if (row.pgid !== undefined) {
      const group = byPgid.get(row.pgid) ?? []
      group.push(row)
      byPgid.set(row.pgid, group)
    }
    if (row.tpgid !== undefined) {
      const foreground = byTpgid.get(row.tpgid) ?? []
      foreground.push(row)
      byTpgid.set(row.tpgid, foreground)
    }
  }
  return { rows, byPid, childrenByPpid, byPgid, byTpgid, stats }
}

export function lookupProcessTableIndex<T>(
  index: ProcessTableIndex,
  lookup: (index: ProcessTableIndex) => T,
  stats = index.stats
): T {
  if (stats) {
    stats.indexLookups += 1
  }
  return lookup(index)
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

const strictReader = createProcessTableSnapshotReader<ProcessTableRow[]>({
  runPs: async () => {
    const { stdout } = await execFile('ps', [...PS_ARGS], {
      encoding: 'utf-8',
      timeout: PS_TIMEOUT_MS
    })
    return parseStrictProcessTableRows(stdout)
  },
  now: () => Date.now()
})

/**
 * Run (or reuse a recent) `ps -axo` process-table scan and return
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

/** Run (or reuse) the strict evidence capture. */
export function getStrictProcessTableSnapshot(): Promise<ProcessTableRow[]> {
  return strictReader.getSnapshot()
}

export function getFreshStrictProcessTableSnapshot(): Promise<ProcessTableRow[]> {
  return strictReader.getFreshSnapshot()
}

/**
 * Test-only: clear the shared snapshot cache so suites that mock `ps` between
 * cases don't have one case's snapshot served to the next within the TTL.
 */
export function resetProcessTableSnapshotForTests(): void {
  defaultReader.reset()
  strictReader.reset()
}
