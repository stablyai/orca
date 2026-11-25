import type { TerminalCursorContext } from './terminal-composer-draft'

// Why: Pi draws no prompt glyph. Its editor is the rows between two full-width `─` rules. Text can sit
// inside a rule: `↑ N more` / `↓ N more` when scrolled, and Pi's working, retry or compaction status
// (`── ⠋ Working... ───`) in the top rule. Pi shows no placeholder, so any undimmed text between the
// rules is the user's draft. No regex: esbuild keeps `─` in regex literals, breaking the ASCII orcad bundle.
function isPiEditorRule(row: string | undefined): boolean {
  const trimmed = row?.trimEnd() ?? ''
  return trimmed.startsWith('─') && trimmed.endsWith('─')
}

/** Whether Pi's editor shows a typed draft, so mail must wait. False when the cursor is not between
 *  two of Pi's editor rules. Callers check that Pi is the pane's agent. */
export function piComposerHoldsDraft(context: TerminalCursorContext): boolean {
  const cursorIndex = context.rows.length - 1
  let top = cursorIndex
  while (top >= 0 && !isPiEditorRule(context.rows[top])) {
    top -= 1
  }
  const bottom = context.rowsBelow.findIndex(isPiEditorRule)
  if (top === -1 || top === cursorIndex || bottom === -1) {
    return false
  }
  const hasText = (row: string): boolean => row.trim() !== ''
  return (
    context.typedRows.slice(top + 1).some(hasText) ||
    context.typedRowsBelow.slice(0, bottom).some(hasText)
  )
}
