import type { TerminalCursorContext } from './terminal-composer-draft'

// Why: OpenCode draws no prompt glyph. Its composer is a `┃` gutter block (closed by `╹▀…` only on
// opaque themes) laid out as a padding row, the textarea, a spacer row and a metadata row (agent,
// model or `Shell`). Its placeholder is undimmed, so only its full stock wording marks it: a placeholder
// a narrow pane cuts short reads as a draft, which only delays a wake, never types over a draft.
const OPENCODE_BOX_GUTTER = '┃'
const OPENCODE_PLACEHOLDERS = ['Ask anything…', 'Run a command…']

/** What the user typed into OpenCode's composer: '' when it is empty, null when the cursor is not in it.
 *  This is the screen copy, so a soft-wrapped draft has a newline at each wrap; it shows that the user
 *  typed something, not exactly what. Callers check that OpenCode is the pane's agent. */
export function readOpenCodeComposerText(context: TerminalCursorContext): string | null {
  const cursorIndex = context.rows.length - 1
  const column = (context.rows[cursorIndex] ?? '').indexOf(OPENCODE_BOX_GUTTER)
  const inBox = (row: string | undefined): boolean =>
    column !== -1 &&
    !!row &&
    row.startsWith(OPENCODE_BOX_GUTTER, column) &&
    !row.slice(0, column).trim()
  if (context.cursorHidden || !inBox(context.rows[cursorIndex])) {
    return null
  }
  let top = cursorIndex
  while (inBox(context.rows[top - 1])) {
    top -= 1
  }
  let below = 0
  while (inBox(context.rowsBelow[below])) {
    below += 1
  }
  const rows = [
    ...context.typedRows.slice(top, cursorIndex + 1),
    ...context.typedRowsBelow.slice(0, below)
  ].map((row) => row.slice(column + OPENCODE_BOX_GUTTER.length).trimEnd())
  const cursorLine = cursorIndex - top
  if (cursorLine === 0 || rows[0]?.trim()) {
    return null
  }
  // Laid out as expected, the box ends with a spacer and a metadata row; otherwise (a footer wrapped
  // in a very narrow pane) only the rows through the cursor are surely the textarea's.
  const spacer = rows.length - 2
  const laidOut = rows.length >= 4 && !rows[spacer]?.trim() && cursorLine < spacer
  // The metadata row shares the textarea's left padding; text past it is the user's.
  const metadata = laidOut ? (rows.at(-1) ?? '') : ''
  const padding = metadata.trim() ? metadata.length - metadata.trimStart().length : 2
  const unpad = (row: string): string =>
    row.startsWith(' '.repeat(padding)) ? row.slice(padding) : row.trimStart()
  const lines = rows.slice(1, laidOut ? spacer : cursorLine + 1).map(unpad)
  const first = lines.findIndex((line) => line.trim())
  const last = lines.findLastIndex((line) => line.trim())
  const placeholder =
    first === 0 &&
    last === 0 &&
    cursorLine === 1 &&
    !unpad(context.beforeCursor.slice(column + OPENCODE_BOX_GUTTER.length)) &&
    OPENCODE_PLACEHOLDERS.some((stock) => lines[0]?.startsWith(stock))
  return first === -1 || placeholder ? '' : lines.slice(first, last + 1).join('\n')
}
