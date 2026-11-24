/**
 * Class for a diff whose other side is empty (a new or deleted file). Every line already carries the
 * line tint there, so main.css drops the stacked character tint and the empty side's opposite tint.
 */
export function wholeFileDiffTintClass(
  originalContent: string,
  modifiedContent: string
): string | undefined {
  if (originalContent.length === 0 && modifiedContent.length > 0) {
    return 'orca-diff-whole-file-added'
  }
  if (modifiedContent.length === 0 && originalContent.length > 0) {
    return 'orca-diff-whole-file-deleted'
  }
  return undefined
}
