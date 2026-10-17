// Why: an xterm selection is a rectangle of screen cells, not logical text.
// Agent CLIs paint their messages behind a fixed left gutter, so every copied
// line carried that gutter into the clipboard and pasted replies came out
// indented (#19770).
//
// Only the run of spaces that *every* non-blank line shares is removed, so
// relative indentation — nested bullets, fenced code, YAML — survives. A
// selection that starts mid-line, or that covers any column-0 line, shares a
// run of zero and comes back untouched.

// Spaces are the whole alphabet here: terminal cells never hold tabs (the
// emulator expands them), and xterm's selectionText getter already folds every
// NBSP cell to a plain space on its way out (SelectionService.ts, the
// ALL_NON_BREAKING_SPACE_REGEX replace) — that is the selection path, not the
// input path.
const LEADING_SPACES = /^ */

type SelectionLine = { indent: number; text: string; terminator: string }

// xterm joins rows with CRLF on Windows, so split('\n') leaves the CR behind.
// It has to travel with the line: without it a blank CRLF row looks like a
// zero-indent content row and would cancel the gutter on Windows only.
function parseLine(rawLine: string): SelectionLine {
  const carriageReturn = rawLine.endsWith('\r')
  const text = carriageReturn ? rawLine.slice(0, -1) : rawLine
  return {
    indent: LEADING_SPACES.exec(text)?.[0].length ?? 0,
    text,
    terminator: carriageReturn ? '\r' : ''
  }
}

function measureGutter(lines: readonly SelectionLine[]): number {
  let gutter = Number.POSITIVE_INFINITY
  for (const { indent, text } of lines) {
    // Blank and whitespace-only lines are evidence of nothing either way.
    if (indent === text.length) {
      continue
    }
    gutter = Math.min(gutter, indent)
    if (gutter === 0) {
      return 0
    }
  }
  return Number.isFinite(gutter) ? gutter : 0
}

export function stripTerminalSelectionGutter(selection: string): string {
  const lines = selection.split('\n').map(parseLine)
  const gutter = measureGutter(lines)
  if (gutter === 0) {
    return selection
  }
  return lines
    .map(({ indent, text, terminator }) => text.slice(Math.min(indent, gutter)) + terminator)
    .join('\n')
}

// Why: agent CLIs (Ink) hard-wrap prose at the pane width, so xterm sees separate rows,
// not soft wraps, and a copied paragraph pastes as ragged lines. With the selection's
// geometry we can also tell a partial first row (selection started mid-line) and the
// `⏺ ` marker row apart from content, which the string-only gutter pass cannot.

export type TerminalSelectionGeometry = {
  // 0-based column of the first selected cell; above 0 the first line is a partial row.
  startCol: number
  cols: number
  // Only when the pane is known to run an agent: indented shell output can look wrapped too.
  joinWrappedRows: boolean
}

// Claude Code marks replies with ⏺ or ● (depends on the platform) and echoes prompts after ❯.
const AGENT_MARKER = /^[⏺●❯] /
// A row starting like this begins a new item; a wrapped row never does.
const BLOCK_START = /^(?:[-*+•◦▪]\s|\d+[.)]\s|[>#|⎿]|```)/
const BOX_DRAWING = /[─-╿]/

function isWideCodePoint(c: number): boolean {
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  )
}

function cellWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if ((c >= 0x300 && c <= 0x36f) || c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) {
      continue
    }
    width += isWideCodePoint(c) ? 2 : 1
  }
  return width
}

type Row = { text: string; indent: number; endCol: number; terminator: string }

function rowEnd(startCol: number, text: string, cols: number): number {
  const end = startCol + cellWidth(text.trimEnd())
  // xterm already joined soft-wrapped rows; only the last screen row's end matters.
  return end > cols ? ((end - 1) % cols) + 1 : end
}

function continues(row: Row, next: Row, wrapWidth: number): boolean {
  const body = next.text.trimStart()
  if (row.text.trim() === '' || body === '' || BLOCK_START.test(body)) {
    return false
  }
  if (BOX_DRAWING.test(row.text) || BOX_DRAWING.test(next.text)) {
    return false
  }
  // A continuation sits at or right of its paragraph's indent; -1 = partial first row.
  if (row.indent >= 0 && next.indent < row.indent) {
    return false
  }
  // Ink moves a word down only when it does not fit after the row's last word.
  const firstWord = body.split(/\s/, 1)[0]
  return row.endCol + 1 + cellWidth(firstWord) > wrapWidth
}

/**
 * Clipboard text for a terminal selection: the agent gutter dropped (also when the
 * selection starts mid-line or on the marker row) and, given the geometry, rows the
 * agent hard-wrapped joined back into their paragraph when `joinWrappedRows` says the pane
 * runs an agent. Text without a gutter is left as is.
 */
export function cleanTerminalSelection(
  selection: string,
  geometry?: TerminalSelectionGeometry
): string {
  if (!geometry) {
    return stripTerminalSelectionGutter(selection)
  }
  const lines = selection.split('\n').map(parseLine)
  const partialFirst = geometry.startCol > 0
  const markerFirst = !partialFirst && AGENT_MARKER.test(lines[0].text)
  const rest = partialFirst || markerFirst ? lines.slice(1) : lines
  const gutter = measureGutter(rest)
  const restHasText = rest.some(({ indent, text }) => indent !== text.length)
  if (gutter === 0 && !(markerFirst && !restHasText)) {
    return selection
  }

  const rows: Row[] = lines.map(({ indent, text, terminator }, i) => {
    if (i === 0 && partialFirst) {
      return {
        text,
        indent: -1,
        endCol: rowEnd(geometry.startCol, text, geometry.cols),
        terminator
      }
    }
    if (i === 0 && markerFirst) {
      return {
        text: text.slice(2),
        indent: 0,
        endCol: rowEnd(0, text, geometry.cols),
        terminator
      }
    }
    const cut = Math.min(indent, gutter)
    return {
      text: text.slice(cut),
      indent: indent - cut,
      endCol: rowEnd(0, text, geometry.cols),
      terminator
    }
  })

  // Why trimEnd: prompt echoes are padded with real spaces to the full pane width.
  for (const row of rows) {
    row.text = row.text.trimEnd()
  }
  if (markerFirst && rows.length > 1 && rows[0].text === '') {
    rows.shift()
  }
  // Rows inside a code fence, and the fence lines themselves, keep their line breaks.
  let fenceOpen = false
  const fenced = rows.map(({ text }) => {
    const isFence = text.trimStart().startsWith('```')
    const inside = fenceOpen || isFence
    if (isFence) {
      fenceOpen = !fenceOpen
    }
    return inside
  })
  // Measured on Claude Code 2.1: Ink fills rows up to and including the last column.
  const wrapWidth = geometry.cols
  const out: string[] = []
  let current = rows[0]
  let joined = current.text
  for (let i = 1; i < rows.length; i++) {
    const next = rows[i]
    const joinable = geometry.joinWrappedRows && !fenced[i - 1] && !fenced[i]
    if (joinable && continues(current, next, wrapWidth)) {
      // A row with no space that fills the width is a long token (URL, path) cut mid-word.
      const midToken = !/\s/.test(current.text.trim()) && current.endCol >= wrapWidth
      joined = joined.trimEnd() + (midToken ? '' : ' ') + next.text.trimStart()
      current = { ...next, indent: current.indent }
      continue
    }
    out.push(joined + current.terminator)
    current = next
    joined = next.text
  }
  out.push(joined + current.terminator)
  return out.join('\n')
}
