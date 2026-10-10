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

// Why narrower than the terminal link detectors' alphabet: ASCII `|` is far
// more often aligned output than a box edge, and the two failures are not
// symmetric — a wrong strip silently eats copied text, a missed one only
// leaves the frame behind for the user to delete.
const FRAME_CHARACTER = /[│┃║╎╏┆┇┊┋]/
const TRAILING_FRAME = / *[│┃║╎╏┆┇┊┋] *$/

type SelectionLine = { indent: number; text: string; terminator: string }

type FramedBlock = { column: number; character: string }

function firstFrameIndex(text: string): number {
  for (let index = 0; index < text.length; index++) {
    if (FRAME_CHARACTER.test(text[index]!)) {
      return index
    }
  }
  return -1
}

// Why: a TUI overlay is composited into the same rows as the screen it covers,
// so a selection started inside the box also takes the box edge and whatever
// showed through beside it. The anchor row is the evidence: it begins inside
// the box, so it is missing the edge every later row carries. A box the user
// selected deliberately has that edge on the anchor row too, and is left alone.
function measureFramedBlock(lines: readonly SelectionLine[]): FramedBlock | null {
  const content = lines.filter((line) => line.indent < line.text.length)
  const [anchor, ...rest] = content
  const [firstContinuation] = rest
  if (!anchor || !firstContinuation || rest.length < 2) {
    return null
  }
  // A box has two sides; a column separator has one. Only the final row may
  // lack the closing edge, because that is where the drag stopped.
  if (!content.slice(0, -1).every((line) => TRAILING_FRAME.test(line.text))) {
    return null
  }
  const column = firstFrameIndex(firstContinuation.text)
  const character = firstContinuation.text[column]
  if (column <= 0 || character === undefined) {
    return null
  }
  const anchorFrame = firstFrameIndex(anchor.text)
  if (anchorFrame !== -1 && anchorFrame <= column) {
    return null
  }
  return rest.every((line) => line.text[column] === character) ? { column, character } : null
}

function stripFrame(line: SelectionLine, frame: FramedBlock): SelectionLine & { framed: boolean } {
  const framed = line.text[frame.column] === frame.character
  const text = (framed ? line.text.slice(frame.column + 1) : line.text).replace(TRAILING_FRAME, '')
  return {
    indent: LEADING_SPACES.exec(text)?.[0].length ?? 0,
    text,
    terminator: line.terminator,
    framed
  }
}

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
  const parsed = selection.split('\n').map(parseLine)
  const frame = measureFramedBlock(parsed)
  const stripped = frame ? parsed.map((line) => stripFrame(line, frame)) : null
  const lines: readonly SelectionLine[] = stripped ?? parsed
  // Why: the anchor row is a partial row, so its accidental start column must
  // not shrink the padding measured from the rows that carry the box edge.
  const gutter = measureGutter(stripped?.filter((line) => line.framed) ?? parsed)
  if (gutter === 0 && !frame) {
    return selection
  }
  return lines
    .map(({ indent, text, terminator }) => text.slice(Math.min(indent, gutter)) + terminator)
    .join('\n')
}
