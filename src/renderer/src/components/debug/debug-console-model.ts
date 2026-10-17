import type { DebugConsoleLine } from '@/lib/debug/use-debug-session'

export const DEBUG_CONSOLE_VIEW_CAP = 2000
export const DEBUG_CONSOLE_HISTORY_CAP = 100

/** Lines the console itself adds: the echoed input and its result or error. */
export type DebugConsoleLocalCategory = 'input' | 'result' | 'error'

export type DebugConsoleLocalLine = {
  /** Last adapter output seq when the line was added, so it sorts after that output. */
  afterSeq: number
  order: number
  category: DebugConsoleLocalCategory
  text: string
}

export type DebugConsoleViewLine = { id: string; category: string; text: string }

// CSI sequences, OSC sequences (BEL or ST terminated), then any other two-byte escape.
const ANSI_PATTERN =
  // oxlint-disable-next-line no-control-regex -- matching terminal escapes is the point.
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

function splitLines(text: string): string[] {
  const pieces = stripAnsi(text).replace(/\r\n/g, '\n').split('\n')
  if (pieces.length > 1 && pieces.at(-1) === '') {
    pieces.pop()
  }
  return pieces
}

/** Adapter output and the console's own lines in arrival order, ANSI stripped, capped to the newest. */
export function buildConsoleView(
  output: readonly DebugConsoleLine[],
  local: readonly DebugConsoleLocalLine[],
  cap = DEBUG_CONSOLE_VIEW_CAP
): DebugConsoleViewLine[] {
  const lines: DebugConsoleViewLine[] = []
  const push = (id: string, category: string, text: string): void => {
    splitLines(text).forEach((piece, index) =>
      lines.push({ id: `${id}:${index}`, category, text: piece })
    )
  }
  let next = 0
  for (const line of output) {
    // Telemetry is adapter bookkeeping, never something the user asked to see.
    if (line.category === 'telemetry') {
      continue
    }
    while (next < local.length && local[next].afterSeq < line.seq) {
      push(`l${local[next].order}`, local[next].category, local[next].text)
      next += 1
    }
    push(`o${line.seq}`, line.category, line.text)
  }
  for (; next < local.length; next += 1) {
    push(`l${local[next].order}`, local[next].category, local[next].text)
  }
  return lines.slice(-cap)
}

export type DebugConsoleHistory = {
  entries: string[]
  /** Position while browsing; null when editing a fresh line. */
  index: number | null
  draft: string
}

export const EMPTY_CONSOLE_HISTORY: DebugConsoleHistory = { entries: [], index: null, draft: '' }

export function pushConsoleHistory(
  history: DebugConsoleHistory,
  entry: string
): DebugConsoleHistory {
  const entries = history.entries.at(-1) === entry ? history.entries : [...history.entries, entry]
  return { entries: entries.slice(-DEBUG_CONSOLE_HISTORY_CAP), index: null, draft: '' }
}

/** Up (-1) walks back through earlier inputs; Down (+1) walks forward and ends on the draft. */
export function stepConsoleHistory(
  history: DebugConsoleHistory,
  direction: -1 | 1,
  current: string
): { history: DebugConsoleHistory; value: string } {
  const { entries, index } = history
  if (entries.length === 0) {
    return { history, value: current }
  }
  if (index === null) {
    if (direction === 1) {
      return { history, value: current }
    }
    const last = entries.length - 1
    return { history: { entries, index: last, draft: current }, value: entries[last] }
  }
  const nextIndex = index + direction
  if (nextIndex < 0) {
    return { history, value: entries[index] }
  }
  if (nextIndex >= entries.length) {
    return { history: { entries, index: null, draft: '' }, value: history.draft }
  }
  return { history: { ...history, index: nextIndex }, value: entries[nextIndex] }
}
