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

/** Columns used by the evidence reader. Keep command last so its spaces survive parsing. */
export const PS_ARGS = (
  process.platform === 'darwin'
    ? ['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,tty=,lstart=,command=']
    : ['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,tty=,etimes=,command=']
) as readonly string[]

// Why: execFile's 1MB default leaves ~3x headroom (326KB / 1,460 processes, and
// a single 5KB argv row is ordinary), so a busy host overflows it and then EVERY
// capture fails — a readable process table degrading into permanent
// "unverifiable". Matches the sibling reader in pty-descendant-termination.ts.
export const PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024

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
