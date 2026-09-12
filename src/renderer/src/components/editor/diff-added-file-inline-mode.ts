/**
 * Whether a diff should ignore Side by Side and render as one inline column.
 *
 * A created file has no original side, so Side by Side draws a blank left
 * column for the whole file and squeezes every new line into the remaining
 * half. An empty column is never what turning Side by Side on asked for.
 *
 * Keyed on content rather than the status string: a rename with edits has a
 * real original and stays two-sided, and a file that gained its first content
 * reads as an addition regardless of how git labelled it.
 *
 * @param diff The two sides about to be handed to Monaco.
 * @returns True when the original side is empty and the modified side is not.
 */
export function shouldForceInlineDiff(diff: {
  originalContent: string
  modifiedContent: string
}): boolean {
  return diff.originalContent.length === 0 && diff.modifiedContent.length > 0
}

/**
 * Resolve the effective `renderSideBySide` for one diff.
 *
 * @param sideBySide The toolbar's global mode, which this never mutates.
 * @param diff The two sides about to be handed to Monaco.
 * @returns The mode Monaco should use for this diff.
 */
export function resolveDiffRenderSideBySide(
  sideBySide: boolean,
  diff: { originalContent: string; modifiedContent: string }
): boolean {
  return sideBySide && !shouldForceInlineDiff(diff)
}
