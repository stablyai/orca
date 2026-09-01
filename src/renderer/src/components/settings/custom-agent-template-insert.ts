// Pure caret-splice helpers for the {repoPath}/{worktreePath} insert controls.
// The placeholders are hints, not alternate storage: they splice literal text
// into whichever template field the user last focused (executable, arguments,
// or a specific env value), never blindly appending to arguments.

export const REPO_PATH_PLACEHOLDER = '{repoPath}'
export const WORKTREE_PATH_PLACEHOLDER = '{worktreePath}'

/** A `<textarea>`/`<input>` selection range captured when a template field is focused. */
export type TemplateFieldSelection = { start: number; end: number }

/** Which template control a placeholder insert targets. Arguments is the default
 *  target when no eligible field is focused (plan: focus Arguments and insert there). */
export type TemplateInsertTarget =
  | { kind: 'commandOverride' }
  | { kind: 'args' }
  | { kind: 'env'; rowId: string }

export type ActiveTemplateField = {
  target: TemplateInsertTarget
  selection: TemplateFieldSelection
}

/** Splice `insertText` into `value` at the captured selection, replacing any
 *  selected span, and return the new value plus the caret position after the
 *  inserted text so the caller can restore the caret. */
export function spliceTemplateValue(
  value: string,
  selection: TemplateFieldSelection,
  insertText: string
): { value: string; caret: number } {
  const start = clampIndex(selection.start, value.length)
  const end = clampIndex(selection.end, value.length)
  const lo = Math.min(start, end)
  const hi = Math.max(start, end)
  const next = value.slice(0, lo) + insertText + value.slice(hi)
  return { value: next, caret: lo + insertText.length }
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index) || index < 0) {
    return length
  }
  return Math.min(index, length)
}
