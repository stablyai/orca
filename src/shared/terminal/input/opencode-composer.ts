import type { TerminalComposerDraft, TerminalCursorContext } from './terminal-composer-draft'

// Why: OpenCode draws no prompt glyph. Its composer is a `┃` gutter block (closed by `╹▀…` only on
// opaque themes) laid out as a padding row, the textarea, a spacer row and a metadata row (agent,
// model or `Shell`). Its placeholder is undimmed, so only its stock wording marks it.
const OPENCODE_BOX_GUTTER = '┃'
const OPENCODE_PLACEHOLDERS = ['Ask anything', 'Run a command']
const ELLIPSIS = '…'

function isOpenCodePlaceholder(line: string): boolean {
  // Narrow panes clip the placeholder to the box width, with or without an ellipsis.
  const shown = line.endsWith(ELLIPSIS) ? line.slice(0, -ELLIPSIS.length) : line
  return OPENCODE_PLACEHOLDERS.some(
    (placeholder) => line.startsWith(placeholder) || (!!shown && placeholder.startsWith(shown))
  )
}

/** OpenCode's composer around the cursor. Its text is the screen copy, so a soft-wrapped draft reads
 *  with a newline at each wrap: it says whether the user typed something, not exactly what. */
export function detectOpenCodeComposer(
  context: TerminalCursorContext
): TerminalComposerDraft | null {
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
  const spacer = rows.length - 2
  if (rows.length < 4 || rows[0]?.trim() || rows[spacer]?.trim() || cursorLine >= spacer) {
    return null
  }
  // The metadata row shares the textarea's left padding; text past it is the user's.
  const metadata = rows.at(-1) ?? ''
  const padding = metadata.trim() ? metadata.length - metadata.trimStart().length : 2
  const unpad = (row: string): string =>
    row.startsWith(' '.repeat(padding)) ? row.slice(padding) : row.trimStart()
  const lines = rows.slice(1, spacer).map(unpad)
  const first = lines.findIndex((line) => line.trim())
  const last = lines.findLastIndex((line) => line.trim())
  const placeholder =
    first === 0 &&
    last === 0 &&
    cursorLine === 1 &&
    !unpad(context.beforeCursor.slice(column + OPENCODE_BOX_GUTTER.length)) &&
    isOpenCodePlaceholder(lines[0] ?? '')
  const text = first === -1 || placeholder ? '' : lines.slice(first, last + 1).join('\n')
  const textareaTop = context.cursorViewportRow - cursorLine + 1
  return {
    text,
    promptRow: textareaTop + Math.max(first, 0),
    cursorRow: context.cursorViewportRow,
    endRow: textareaTop + Math.max(last, first, 0),
    promptGlyph: OPENCODE_BOX_GUTTER
  }
}
