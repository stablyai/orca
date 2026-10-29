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

// Guard process at module load: sandboxed renderers import this half and a bare read would crash the chunk/app.
const HOST_IS_DARWIN = typeof process !== 'undefined' && process.platform === 'darwin'

/** Columns used by the evidence reader. Keep command last so its spaces survive parsing. */
export const PS_ARGS = (
  HOST_IS_DARWIN
    ? ['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,tty=,lstart=,command=']
    : ['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,tty=,etimes=,command=']
) as readonly string[]

/** Cheap tier proves unchanged subtrees, never process names. Drop costly macOS tty (0.29/0.34s at 1,900 processes)
 * and Linux argv (1.15s); omit ticking etimes and read stable /proc starts for the pane subtree. */
export const CHEAP_PS_ARGS = (
  HOST_IS_DARWIN
    ? ['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,lstart=']
    : ['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=']
) as readonly string[]

/** Shell-proof tier keeps job control/argv, dropping costly unused tty/start columns; enough to name foreground processes,
 * never correlate reused PIDs across captures. */
export const SHELL_FOREGROUND_PS_ARGS = [
  '-axo',
  'pid=,ppid=,pgid=,tpgid=,stat=,command='
] as readonly string[]

/** Match shell-tier columns exactly: the full parser’s optional tty/start pair eats argv like python 3 app.py and misreads zombies.
 * Drop invalid rows, but reject empty captures so missing data cannot prove the shell exited. */
export function parseShellForegroundRows(stdout: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const match = rawLine.trim().match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(.+)$/)
    const pid = match ? Number(match[1]) : 0
    if (match && Number.isSafeInteger(pid) && pid > 0) {
      rows.push({
        pid,
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        tpgid: Number(match[4]),
        stat: match[5],
        command: match[6]
      })
    }
  }
  if (rows.length === 0) {
    throw new ProcessTableCaptureError('empty_capture')
  }
  return rows
}

export type CheapProcessTableRow = {
  pid: number
  ppid: number
  pgid: number
  tpgid: number
  stat: string
  /** Host start marker when the column set carries one (macOS `lstart`). */
  startTime?: string
}

/** Lenient cheap rows only make fingerprints differ and trigger strict capture; empty still means unreadable, never no processes. */
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

// Node’s 1MB default overflows busy captures (~326KB/1,460 rows; 5KB argv is ordinary), making all reads unverifiable.
// Match pty-descendant-termination.ts’s 32MB ceiling.
export const PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024

/** TTL beyond capture duration; reported age includes both. Renderer cadence also needs this bound,
 * so keep it out of the node:child_process reader graph. */
export const PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS = 500

/** Parse legacy/evidence ps rows with CRLF tolerance; anchored greedy final command preserves internal spaces. */
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

/** Require every nonframing row: silently dropping truncation could falsely prove no agent. Accept kernel/TTY sentinels
 * ppid/pgid=0 and tpgid=-1/0; reject pid<=0, negative ppid/pgid or tpgid<-1. Empty/header-only captures are unreadable. */
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
