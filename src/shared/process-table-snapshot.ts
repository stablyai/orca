export type ProcessTableRow = {
  pid: number
  ppid: number
  /** Process group id. Optional only on rows produced by the legacy parser input shape. */
  pgid?: number
  /** Terminal foreground process group id (`0`/`-1` means no controlling tty). */
  tpgid?: number
  /** Controlling terminal name, when the host process table provides it. */
  tty?: string
  /** Opaque host process start marker (Linux /proc ticks or host ps marker). */
  startTime?: string
  stat: string
  command: string
}

// Why guarded: this module is the renderer-safe half of the process-table pair, and the renderer
// runs sandboxed with contextIsolation, where a bare `process` read throws at module evaluation
// and takes the whole chunk — and the app — down with it. Only hosts ever run these argv.
const HOST_IS_DARWIN = typeof process !== 'undefined' && process.platform === 'darwin'

/** Columns used by the evidence reader. Keep command last so its spaces survive parsing. */
export const PS_ARGS = (
  HOST_IS_DARWIN
    ? ['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,tty=,lstart=,command=']
    : ['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,tty=,etimes=,command=']
) as readonly string[]

/**
 * Cheap tier: the same job-control columns without `tty=` (0.29s of the 0.34s on a
 * 1,900-process Mac) or `command=` (per-pid argv read, 1.15s on Linux). Enough to prove a
 * pane's subtree is unchanged since the last full capture; never enough to name a process.
 * No `etimes=` on Linux: it is elapsed seconds, so it changes every tick; the stable start
 * marker comes from `/proc/<pid>/stat` for the pane subtree only.
 */
export const CHEAP_PS_ARGS = (
  HOST_IS_DARWIN
    ? ['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,lstart=']
    : ['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=']
) as readonly string[]

export type CheapProcessTableRow = {
  pid: number
  ppid: number
  pgid: number
  tpgid: number
  stat: string
  /** Host start marker when the column set carries one (macOS `lstart`). */
  startTime?: string
}

/**
 * Parse a {@link CHEAP_PS_ARGS} capture. Lenient on purpose: a dropped row can only make a
 * fingerprint DIFFER from the strict full-capture one, which escalates to the full capture --
 * the safe direction. An empty capture is unreadable, not "no processes".
 */
export function parseCheapProcessTableRows(stdout: string): CheapProcessTableRow[] {
  const rows: CheapProcessTableRow[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const match = rawLine.trim().match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)(?:\s+(.+?))?$/)
    if (!match) {
      continue
    }
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      continue
    }
    rows.push({
      pid,
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      tpgid: Number(match[4]),
      stat: match[5],
      ...(match[6] !== undefined ? { startTime: match[6] } : {})
    })
  }
  if (rows.length === 0) {
    throw new ProcessTableCaptureError('empty_capture')
  }
  return rows
}

// Why: execFile's 1MB default leaves ~3x headroom (326KB / 1,460 processes, and
// a single 5KB argv row is ordinary), so a busy host overflows it and then EVERY
// capture fails — a readable process table degrading into permanent
// "unverifiable". Matches the sibling reader in pty-descendant-termination.ts.
export const PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024

/** How much older than its own await a TTL-cached capture may be, on top of the capture's own
 *  duration. Reported ages carry both, so this alone is not the staleness bound.
 *
 *  Why here and not beside the reader that applies it: the renderer's cadence scheduler pulls a
 *  pane's next poll forward by at most this much, and the reader is a `node:child_process` module
 *  the renderer must never reach. */
export const PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS = 500

/**
 * Parse legacy or evidence-shaped `ps` output into rows. Tolerates CRLF so a
 * snapshot parsed on any host stays correct; `command` (last field) keeps its
 * internal spaces because the regex is anchored and greedy on the tail.
 */
export function parseProcessTableRows(stdout: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    const macStartMatch = trimmed.match(
      /^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(\S+\s+\S+\s+\d{1,2}\s+\S+\s+\d{4})\s+(.+)$/
    )
    if (macStartMatch) {
      rows.push({
        pid: Number(macStartMatch[1]),
        ppid: Number(macStartMatch[2]),
        pgid: Number(macStartMatch[3]),
        tpgid: Number(macStartMatch[4]),
        stat: macStartMatch[5],
        tty: macStartMatch[6],
        startTime: macStartMatch[7],
        command: macStartMatch[8]
      })
      continue
    }
    const evidenceMatch = trimmed.match(
      /^(\d+)\s+(\d+)\s+(?:(-?\d+)\s+(-?\d+)\s+)?(\S+)(?:\s+(\S+)\s+(\d+))?\s+(.+)$/
    )
    if (evidenceMatch) {
      rows.push({
        pid: Number(evidenceMatch[1]),
        ppid: Number(evidenceMatch[2]),
        ...(evidenceMatch[3] !== undefined
          ? { pgid: Number(evidenceMatch[3]), tpgid: Number(evidenceMatch[4]) }
          : {}),
        stat: evidenceMatch[5] ?? evidenceMatch[3],
        ...(evidenceMatch[7] !== undefined
          ? { tty: evidenceMatch[6], startTime: evidenceMatch[7] }
          : {}),
        command: evidenceMatch[8] ?? evidenceMatch[6] ?? evidenceMatch[4]
      } as ProcessTableRow)
      continue
    }
    const legacyMatch = trimmed.match(
      /^((?:\d+)\s+(?:\d+)\s+)(?:(-?\d+)\s+(-?\d+)\s+)?(\S+)\s+(.+)$/
    )
    if (legacyMatch) {
      rows.push({
        pid: Number(legacyMatch[1].trim().split(/\s+/)[0]),
        ppid: Number(legacyMatch[1].trim().split(/\s+/)[1]),
        ...(legacyMatch[2] !== undefined
          ? { pgid: Number(legacyMatch[2]), tpgid: Number(legacyMatch[3]) }
          : {}),
        stat: legacyMatch[4],
        command: legacyMatch[5]
      } as ProcessTableRow)
    }
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
    const macStartMatch = line.match(
      /^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(\S+\s+\S+\s+\d{1,2}\s+\S+\s+\d{4})\s+(.+)$/
    )
    const numericMatch = macStartMatch
      ? null
      : line.match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)(?:\s+(\S+)\s+(\d+))?\s+(.+)$/)
    if (!numericMatch && !macStartMatch) {
      throw new ProcessTableCaptureError('malformed_row')
    }
    const match = numericMatch ?? macStartMatch!
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
      (match[8] ?? match[6]).length === 0
    ) {
      throw new ProcessTableCaptureError('invalid_numeric_field')
    }
    rows.push({
      pid,
      ppid,
      pgid,
      tpgid,
      stat: match[5],
      ...(numericMatch && match[7] !== undefined
        ? { tty: match[6], startTime: match[7] }
        : macStartMatch
          ? { tty: match[6], startTime: match[7] }
          : {}),
      command: numericMatch ? (match[8] ?? match[6]) : match[8]
    })
  }
  if (rows.length === 0) {
    throw new ProcessTableCaptureError('empty_capture')
  }
  return rows
}

/**
 * Rank a descendant row as a foreground candidate: a `+` (foreground process
 * group) row always outranks a background one, then the deepest wins.
 */
export function scoreForegroundCandidateRow(row: ProcessTableRow & { depth: number }): number {
  return (row.stat.includes('+') ? 10_000 : 0) + row.depth
}
