import type { TerminalCursorContext } from './terminal-composer-draft'

// Why: Pi draws no prompt glyph. Its editor is the rows between two full-width `─` rules. Text can sit
// inside a rule: `↑ N more` / `↓ N more` when scrolled, and Pi's working, retry or compaction status
// (`── ⠋ Working... ───`) in the top rule. Pi shows no placeholder, so any undimmed text between the
// rules is the user's draft. No regex: esbuild keeps `─` in regex literals, breaking the ASCII orcad bundle.
function isPiEditorRule(row: string | undefined): boolean {
  const trimmed = row?.trimEnd() ?? ''
  return trimmed.startsWith('─') && trimmed.endsWith('─')
}

// An extension's own editor (pi-zentui's `| ` rail, a `│ … │` box) can put status rows, such as the
// model, between the rules. Its layout is unknown here; Orca's Pi extension reports that box's draft.
const EXTENSION_EDITOR_GUTTERS = ['|', '│', '┃', '▎', '▌', '▏']

function isExtensionEditorRow(row: string): boolean {
  const first = row.trimStart()[0]
  return first !== undefined && EXTENSION_EDITOR_GUTTERS.includes(first)
}

/** Whether Pi's built-in editor shows a typed draft, so mail must wait. False when the cursor is not
 *  between two of Pi's editor rules or an extension draws the box. Callers check that Pi is the pane's agent. */
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
  if (
    [...context.rows.slice(top + 1), ...context.rowsBelow.slice(0, bottom)].some(
      isExtensionEditorRow
    )
  ) {
    return false
  }
  const hasText = (row: string): boolean => row.trim() !== ''
  return (
    context.typedRows.slice(top + 1).some(hasText) ||
    context.typedRowsBelow.slice(0, bottom).some(hasText)
  )
}
