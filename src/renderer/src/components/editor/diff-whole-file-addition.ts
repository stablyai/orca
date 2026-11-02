/** Clears Monaco's added-line tint; styled in main.css. */
export const WHOLE_FILE_ADDITION_DIFF_CLASS = 'orca-diff-whole-file-addition'

// An empty original side makes every line an addition, so the added tint marks nothing.
export function isWholeFileAddition(originalContent: string, modifiedContent: string): boolean {
  return originalContent.length === 0 && modifiedContent.length > 0
}
