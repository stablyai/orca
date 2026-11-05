import type { TerminalCursorContext } from './terminal-composer-draft'

// Why: OpenCode draws no prompt glyph. Its composer is a `┃` gutter block (closed by `╹▀…` only on
// opaque themes) laid out as a padding row, the textarea, a spacer row and a metadata row (agent,
// model or `Shell`). Its placeholder is undimmed, so only its full stock wording marks it: a placeholder
// a narrow pane cuts short reads as a draft, which only delays a wake, never types over a draft.
const OPENCODE_BOX_GUTTER = '┃'
const OPENCODE_PLACEHOLDERS = ['Ask anything…', 'Run a command…']

/** Whether OpenCode's composer may hold a typed draft, so mail must wait. False when the cursor is
 *  not in its textarea. A box not laid out as expected (a footer wrapped in a very narrow pane) holds,
 *  since its textarea rows cannot be told from the footer's. Callers check OpenCode is the pane's agent. */
export function openCodeComposerHoldsDraft(context: TerminalCursorContext): boolean {
  const cursorIndex = context.rows.length - 1
  const column = (context.rows[cursorIndex] ?? '').indexOf(OPENCODE_BOX_GUTTER)
  const inBox = (row: string | undefined): boolean =>
    column !== -1 &&
    !!row &&
    row.startsWith(OPENCODE_BOX_GUTTER, column) &&
    !row.slice(0, column).trim()
  if (context.cursorHidden || !inBox(context.rows[cursorIndex])) {
    return false
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
  ].map((row) => row.slice(column + OPENCODE_BOX_GUTTER.length).trim())
  const cursorLine = cursorIndex - top
  const spacer = rows.length - 2
  // The cursor sits below the box's blank padding row; anything else is not OpenCode's composer.
  if (cursorLine === 0 || rows[0]) {
    return false
  }
  if (rows.length < 4 || rows[spacer] || cursorLine >= spacer) {
    return true
  }
  const typed = rows.slice(1, spacer).filter(Boolean)
  const placeholder =
    typed.length === 1 &&
    cursorLine === 1 &&
    rows[1] === typed[0] &&
    !context.beforeCursor.slice(column + OPENCODE_BOX_GUTTER.length).trim() &&
    OPENCODE_PLACEHOLDERS.some((stock) => typed[0]?.startsWith(stock))
  return typed.length > 0 && !placeholder
}
