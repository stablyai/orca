import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import type { ProcessTableIndexOf } from './process-table-index'

const execFile = promisify(execFileCb)

// Why: agent foreground-process inspection runs this full process-table scan on
// a 750ms/2000ms per-pane cadence. On a shared SSH relay every tracked agent
// terminal drives it, so concurrent panes used to each fork their own `ps`,
// pinning idle CPU (issue #6288). Memoizing collapses overlapping scans to one.
/** Columns used by the evidence reader. Keep command last so its spaces survive parsing. */
export const PS_ARGS = ['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,command='] as const
const PS_TIMEOUT_MS = 3000
// Why: execFile's 1MB default leaves ~3x headroom (326KB / 1,460 processes, and
// a single 5KB argv row is ordinary), so a busy host overflows it and then EVERY
// capture fails — a readable process table degrading into permanent
// "unverifiable". Matches the sibling reader in pty-descendant-termination.ts.
export const PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024

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

export type ProcessTableIndex = ProcessTableIndexOf<ProcessTableRow>

/**
 * Rank a descendant row as a foreground candidate: a `+` (foreground process
 * group) row always outranks a background one, then the deepest wins.
 */
export function scoreForegroundCandidateRow(row: ProcessTableRow & { depth: number }): number {
  return (row.stat.includes('+') ? 10_000 : 0) + row.depth
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

/**
 * One capture, two views. The lenient and strict readers issue byte-identical
 * `ps` argv, so giving them separate memoizers would fork `ps` twice per TTL
 * window on a relay that serves both — the exact doubling issue #6288 removed.
 * Each parse is memoized per capture (including a strict failure) so a burst of
 * panes sharing the window re-tokenizes nothing.
 */
type ProcessTableCapture = {
  lenient: () => ProcessTableRow[]
  strict: () => ProcessTableRow[]
}

function createProcessTableCapture(stdout: string): ProcessTableCapture {
  let lenientRows: ProcessTableRow[] | null = null
  let strictResult: { rows: ProcessTableRow[] } | { error: unknown } | null = null
  return {
    lenient: () => (lenientRows ??= parseProcessTableRows(stdout)),
    strict: () => {
      if (strictResult === null) {
        try {
          strictResult = { rows: parseStrictProcessTableRows(stdout) }
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

/**
 * Reject a capture that cannot be a whole process table.
 *
 * Why this is not redundant with the buffer ceiling: `parseProcessTableRows`
 * drops unparseable lines, so a short capture reads as a *complete* table whose
 * missing processes simply are not running — a false "no agent"/"no children",
 * i.e. the `unverifiable` -> `exited` collapse the execution boundary forbids.
 * Only the strict view would notice today; the lenient view would not. A capture
 * that stopped at the ceiling, or that carries no rows at all, is unreadable
 * evidence and must fail loudly on both views.
 */
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
    return createProcessTableCapture(assertWholeCapture(stdout))
  },
  now: () => Date.now()
})

/** How much older than its own await a snapshot from the shared reader may be. The reader serves a
 *  capture from its TTL cache, so a caller that needs to state the observation's age must assume
 *  this whole window rather than the instant its await settled. */
export const PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS = DEFAULT_SNAPSHOT_TTL_MS

/**
 * Run (or reuse a recent) `ps -axo` process-table scan and return
 * its parsed rows. Per-process singleton: the relay and local main processes
 * each dedupe their own scans and share a single parse per TTL window.
 */
export async function getProcessTableSnapshot(): Promise<ProcessTableRow[]> {
  return (await processTableReader.getSnapshot()).lenient()
}

/** Capture process rows from a scan that starts after this request. */
export async function getFreshProcessTableSnapshot(): Promise<ProcessTableRow[]> {
  return (await processTableReader.getFreshSnapshot()).lenient()
}

/** Strict evidence view of the same deduplicated capture. */
export async function getStrictProcessTableSnapshot(): Promise<ProcessTableRow[]> {
  return (await processTableReader.getSnapshot()).strict()
}

/**
 * Test-only: clear the shared snapshot cache so suites that mock `ps` between
 * cases don't have one case's snapshot served to the next within the TTL.
 */
export function resetProcessTableSnapshotForTests(): void {
  processTableReader.reset()
}
