import type { TerminalLinkBuffer, TerminalLinkBufferRange } from './terminal-link-buffer'
import {
  rangeForParsedFileLink,
  translateLineWithColumns,
  type WrappedLogicalLine
} from './wrapped-terminal-link-ranges'

/** A `! command` line an agent CLI printed for the user to run (Claude Code, Codex and Gemini bash mode). */
export type TerminalSuggestedCommand = {
  /** Exactly what the user would paste, wrapped rows rejoined, including the leading `!`. */
  text: string
  /** Zero-based buffer rows the command occupies. */
  startY: number
  endY: number
  range: TerminalLinkBufferRange
}

type CommandRow = {
  y: number
  text: string
  columns: number[]
  indentColumn: number
  endColumn: number
  lineLength: number
  isWrapped: boolean
  /** Trimmed whitespace at either edge; it is content only where xterm soft-wraps mid-line. */
  leadingWhitespace: string
  trailingWhitespace: string
}

const MAX_SUGGESTED_COMMAND_ROWS = 12
const MAX_SUGGESTED_COMMAND_CHARS = 4_000
// Agent TUIs reserve a small right margin, so a word-wrapped row ends a few cells short of the edge.
const WORD_WRAP_RIGHT_SLACK = 6
const COMMAND_START_RE = /^! \S/
// Rows that start a new block rather than continue a wrapped command.
const NEW_BLOCK_START_RE = /^(?:! |[-*+•●⎿✻※❯] |[│╭╰─]|\d+[.)] )/

function readCommandRow(buffer: TerminalLinkBuffer, y: number): CommandRow | null {
  const line = buffer.getLine(y)
  if (!line) {
    return null
  }
  const translated = translateLineWithColumns(line)
  const start = translated.text.search(/\S/)
  if (start === -1) {
    return null
  }
  let end = translated.text.length
  while (end > start && /\s/.test(translated.text[end - 1])) {
    end--
  }
  return {
    y,
    text: translated.text.slice(start, end),
    columns: translated.columns.slice(start, end + 1),
    indentColumn: translated.columns[start] ?? start,
    endColumn: translated.columns[end] ?? end,
    lineLength: line.length,
    isWrapped: line.isWrapped,
    leadingWhitespace: translated.text.slice(0, start),
    trailingWhitespace: translated.text.slice(end)
  }
}

function firstWordWidth(row: CommandRow): number {
  const spaceIndex = row.text.search(/\s/)
  const wordEnd = spaceIndex === -1 ? row.text.length : spaceIndex
  return (row.columns[wordEnd] ?? wordEnd) - (row.columns[0] ?? 0)
}

const TRAILING_SHELL_OPERATOR_RE = /(?:\\|\|\|?|&&|[<>]|\()$/
// A sentence the agent printed after the command, not a wrapped argument.
const PROSE_ROW_RE = /^(?:[A-Z][a-z]|[\u0080-\uFFFF]).*[.!?:。]$/

/** Open quote at the end of `text`, and whether its last character is an escaping backslash. */
function scanShellQuotes(text: string): { quote: '"' | "'" | null; trailingEscape: boolean } {
  let quote: '"' | "'" | null = null
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '\\' && quote !== "'") {
      if (index === text.length - 1) {
        return { quote, trailingEscape: true }
      }
      index++
    } else if (quote === null && (char === '"' || char === "'")) {
      quote = char
    } else if (char === quote) {
      quote = null
    }
  }
  return { quote, trailingEscape: false }
}

/** True when the shell would still wait for input: an open quote or a trailing operator. */
export function isIncompleteShellCommand(text: string): boolean {
  return scanShellQuotes(text).quote !== null || TRAILING_SHELL_OPERATOR_RE.test(text)
}

/** The command text once `next` is added, as the shell would read the rows the agent printed. */
function appendCommandRow(command: string, previous: CommandRow, next: CommandRow): string {
  if (next.isWrapped) {
    // Soft wraps split wherever the row filled up, so the edge whitespace is content.
    return command + previous.trailingWhitespace + next.leadingWhitespace + next.text
  }
  // Why: the shell drops a backslash-newline; keeping the backslash would escape the joining space.
  if (scanShellQuotes(command).trailingEscape) {
    return command.slice(0, -1) + next.text
  }
  return `${command} ${next.text}`
}

/** True when `next` is the rest of a command the agent wrapped after `previous`. */
function continuesCommand(
  start: CommandRow,
  previous: CommandRow,
  next: CommandRow,
  commandSoFar: string
): boolean {
  if (next.isWrapped) {
    return true
  }
  if (next.indentColumn < start.indentColumn || NEW_BLOCK_START_RE.test(next.text)) {
    return false
  }
  // Why: agents may wrap narrower than the terminal; an unfinished command must not run cut short.
  if (isIncompleteShellCommand(commandSoFar)) {
    return true
  }
  if (PROSE_ROW_RE.test(next.text)) {
    return false
  }
  // Why: a sentence after the command fits on the previous row; a wrapped tail's first word does not.
  return previous.endColumn + 1 + firstWordWidth(next) > previous.lineLength - WORD_WRAP_RIGHT_SLACK
}

function collectCommandRows(
  buffer: TerminalLinkBuffer,
  start: CommandRow
): { rows: CommandRow[]; text: string } | null {
  const rows = [start]
  let text = start.text
  for (let y = start.y + 1; ; y++) {
    const next = readCommandRow(buffer, y)
    // oxlint-disable-next-line unicorn/prefer-at -- the phone's terminal WebView (Chrome 74) has no Array#at
    const previous = rows[rows.length - 1]
    if (!next || !continuesCommand(start, previous, next, text)) {
      break
    }
    // Why: a command longer than the limits would run without its tail.
    if (rows.length >= MAX_SUGGESTED_COMMAND_ROWS) {
      return null
    }
    text = appendCommandRow(text, previous, next)
    if (text.length > MAX_SUGGESTED_COMMAND_CHARS) {
      return null
    }
    rows.push(next)
  }
  // Why: a command whose tail could not be found is unsafe to run as shown.
  return isIncompleteShellCommand(text) ? null : { rows, text }
}

/** Rows laid end to end for link-range mapping; the runnable text is built separately. */
function toLogicalLine(rows: CommandRow[]): WrappedLogicalLine {
  let text = ''
  const logicalRows = rows.map((row, index) => {
    if (index > 0) {
      text += ' '
    }
    const startIndex = text.length
    text += row.text
    return {
      y: row.y,
      text: row.text,
      sourceText: row.text,
      columns: row.columns,
      startIndex,
      isWrapped: row.isWrapped,
      lineLength: row.lineLength
    }
  })
  return { text, rows: logicalRows, fingerprint: text }
}

/**
 * Finds the suggested command covering `bufferLineNumber` (1-based, as xterm link providers pass it).
 * `excludeY` is the cursor row: a `! ` there is the user's own prompt draft, not agent output.
 */
export function findTerminalSuggestedCommand(
  buffer: TerminalLinkBuffer,
  bufferLineNumber: number,
  excludeY?: number
): TerminalSuggestedCommand | null {
  const y = bufferLineNumber - 1
  for (let startY = y; startY > y - MAX_SUGGESTED_COMMAND_ROWS && startY >= 0; startY--) {
    const start = readCommandRow(buffer, startY)
    if (!start) {
      return null
    }
    if (!COMMAND_START_RE.test(start.text)) {
      if (startY < y && !start.isWrapped && NEW_BLOCK_START_RE.test(start.text)) {
        return null
      }
      continue
    }
    const collected = collectCommandRows(buffer, start)
    if (!collected) {
      return null
    }
    const { rows, text } = collected
    // oxlint-disable-next-line unicorn/prefer-at -- the phone's terminal WebView (Chrome 74) has no Array#at
    const endY = rows[rows.length - 1].y
    if (endY < y) {
      return null
    }
    if (excludeY !== undefined && excludeY >= startY && excludeY <= endY) {
      return null
    }
    const logicalLine = toLogicalLine(rows)
    const range = rangeForParsedFileLink(logicalLine, 0, logicalLine.text.length)
    return range ? { text, startY, endY, range } : null
  }
  return null
}
