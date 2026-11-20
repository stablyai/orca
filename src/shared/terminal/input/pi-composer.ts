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
// Such a box draws an empty padding row that is only its gutter beside at least one other row; a
// lone `|` typed into Pi's own box is one row, and longer text starting with `|` is not padding.
const EXTENSION_EDITOR_GUTTERS = ['|', '│', '┃', '▎', '▌', '▏']

function isGutter(char: string | undefined): boolean {
  return char !== undefined && EXTENSION_EDITOR_GUTTERS.includes(char)
}

function isExtensionPaddingRow(row: string): boolean {
  const trimmed = row.trim()
  if (!isGutter(trimmed[0])) {
    return false
  }
  const inner = isGutter(trimmed.at(-1)) ? trimmed.slice(1, -1) : trimmed.slice(1)
  return inner.trim() === ''
}

function isExtensionEditor(rows: string[]): boolean {
  const drawn = rows.filter((row) => row.trim() !== '')
  return (
    drawn.length > 1 &&
    drawn.some(isExtensionPaddingRow) &&
    drawn.every((row) => isGutter(row.trim()[0]))
  )
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
  if (isExtensionEditor([...context.rows.slice(top + 1), ...context.rowsBelow.slice(0, bottom)])) {
    return false
  }
  const hasText = (row: string): boolean => row.trim() !== ''
  return (
    context.typedRows.slice(top + 1).some(hasText) ||
    context.typedRowsBelow.slice(0, bottom).some(hasText)
  )
}
