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
