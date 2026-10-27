// Remove only the spaces shared by every nonblank selection row so copied agent gutters disappear without losing relative code/list indentation.
// Column-0 or mid-line selections share no gutter and stay untouched.

// Selections contain expanded tabs and xterm-normalized NBSP, so only plain spaces need matching.
const LEADING_SPACES = /^ */

type SelectionLine = { indent: number; text: string; terminator: string }

// Keep Windows CR with its row; otherwise a blank CRLF row appears to have zero-indent content and cancels the gutter.
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
