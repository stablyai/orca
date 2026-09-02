export const COMBINED_DIFF_FILE_TREE_MIN_WIDTH = 200
export const COMBINED_DIFF_FILE_TREE_DEFAULT_WIDTH = 256
export const COMBINED_DIFF_FILE_TREE_MIN_DIFF_WIDTH = 200
export const COMBINED_DIFF_FILE_TREE_MAX_WIDTH = 640
export const COMBINED_DIFF_FILE_TREE_RESIZE_STEP = 16

export function computeCombinedDiffFileTreeWidthBounds(containerWidth: number): {
  maxWidth: number
  minWidth: number
} {
  // Why: a hidden pane measures 0; treat that as "unknown" so it can't shrink the stored width.
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return {
      maxWidth: COMBINED_DIFF_FILE_TREE_MAX_WIDTH,
      minWidth: COMBINED_DIFF_FILE_TREE_MIN_WIDTH
    }
  }

  const fittedMax = Math.min(
    COMBINED_DIFF_FILE_TREE_MAX_WIDTH,
    containerWidth - COMBINED_DIFF_FILE_TREE_MIN_DIFF_WIDTH
  )
  if (fittedMax >= COMBINED_DIFF_FILE_TREE_MIN_WIDTH) {
    return { maxWidth: fittedMax, minWidth: COMBINED_DIFF_FILE_TREE_MIN_WIDTH }
  }

  // Why: below both minimums combined nothing fits, so split the container evenly rather than
  // hold the tree at its minimum and push the diff pane out of the container.
  const shared = Math.max(0, Math.floor(containerWidth / 2))
  return { maxWidth: shared, minWidth: shared }
}

export function clampCombinedDiffFileTreeWidth(
  width: unknown,
  containerWidth?: number,
  fallback = COMBINED_DIFF_FILE_TREE_DEFAULT_WIDTH
): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return fallback
  }

  const { maxWidth, minWidth } =
    containerWidth !== undefined
      ? computeCombinedDiffFileTreeWidthBounds(containerWidth)
      : {
          maxWidth: COMBINED_DIFF_FILE_TREE_MAX_WIDTH,
          minWidth: COMBINED_DIFF_FILE_TREE_MIN_WIDTH
        }

  return Math.min(maxWidth, Math.max(minWidth, width))
}
