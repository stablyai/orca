import type { TerminalCursorContext } from './terminal-composer-draft'

// Why: OpenCode draws no prompt glyph. Its composer is a `┃` gutter block (closed by `╹▀…` only on
// opaque themes) laid out as a padding row, the textarea, a spacer row and a metadata row (agent,
// model or `Shell`). Its placeholder is undimmed, so only its full stock wording marks it: a placeholder
// a narrow pane cuts short reads as a draft, which only delays a wake, never types over a draft.
const OPENCODE_BOX_GUTTER = '┃'
// A stock prompt, then a quoted example that a narrow box may cut short.
const OPENCODE_PLACEHOLDER = /^(?:Ask anything\u2026|Run a command\u2026)(?: "[^"]*"?)?$/

/** Typed textarea, empty placeholder, or null when the cursor is outside OpenCode's composer. */
export function readOpenCodeComposerTypedText(context: TerminalCursorContext): string | null {
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
  ].map((row) => row.slice(column + OPENCODE_BOX_GUTTER.length).trim())
  const cursorLine = cursorIndex - top
  // The footer follows the last blank row, the spacer; a narrow pane wraps it onto more rows.
  const spacer = rows.findLastIndex((row) => !row)
  // Not a padding row, textarea, spacer and footer around the cursor: read as any other prompt.
  if (cursorLine === 0 || rows[0] || spacer <= cursorLine || spacer === rows.length - 1) {
    return null
  }
  const textarea = rows.slice(1, spacer)
  // The placeholder wraps onto more rows in a narrow box.
  const shown = textarea.join(' ').trim()
  const placeholder =
    cursorLine === 1 &&
    textarea.every(Boolean) &&
    !context.beforeCursor.slice(column + OPENCODE_BOX_GUTTER.length).trim() &&
    OPENCODE_PLACEHOLDER.test(shown)
  return placeholder ? '' : textarea.join('\n').trim()
}

export function openCodeComposerHoldsDraft(context: TerminalCursorContext): boolean {
  return !!readOpenCodeComposerTypedText(context)
}
