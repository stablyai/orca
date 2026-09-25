import {
  readTerminalCursorLineContext,
  type TerminalCursorContextSource
} from './terminal-cursor-line-context'

/** Only accept a complete dim suggestion in Claude's otherwise empty input frame. */
export function readClaudeTerminalPromptSuggestion(
  terminal: TerminalCursorContextSource
): string | null {
  const context = readTerminalCursorLineContext(terminal, 1)
  if (!context || context.cursorHidden || context.rows.length !== 2) {
    return null
  }
  if (!/^[─━-]{8,}\s*$/.test(context.rows[0])) {
    return null
  }
  if (!/^[─━-]{8,}\s*$/.test(context.rowsBelow[0] ?? '')) {
    return null
  }
  if (!/^❯\s*$/.test(context.beforeCursor) || context.afterCursor.trim()) {
    return null
  }
  if (!/^❯\s*$/.test(context.typedRows[1])) {
    return null
  }
  const suggestion = context.rawAfterCursor.trim()
  // Stock startup placeholders use the same dim cells but cannot be accepted by Claude.
  return suggestion && !/^Try\s+["“]/.test(suggestion) ? suggestion : null
}
