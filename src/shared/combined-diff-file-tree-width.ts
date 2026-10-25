export const COMBINED_DIFF_FILE_TREE_MIN_WIDTH = 200
export const COMBINED_DIFF_FILE_TREE_DEFAULT_WIDTH = 256
export const COMBINED_DIFF_FILE_TREE_MIN_DIFF_WIDTH = 200
export const COMBINED_DIFF_FILE_TREE_MAX_WIDTH = 640
export const COMBINED_DIFF_FILE_TREE_RESIZE_STEP = 16

export function computeCombinedDiffFileTreeWidthBounds(containerWidth: number): {
  maxWidth: number
  minWidth: number
} {
  // Hidden panes measure zero; treat it as unknown so stored width cannot shrink.
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

  // Below both minimums, divide evenly rather than push the diff outside its container.
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
