export const COMBINED_DIFF_FILE_TREE_MIN_WIDTH = 200
export const COMBINED_DIFF_FILE_TREE_DEFAULT_WIDTH = 256
export const COMBINED_DIFF_FILE_TREE_MIN_DIFF_WIDTH = 200
export const COMBINED_DIFF_FILE_TREE_MAX_WIDTH = 640
export const COMBINED_DIFF_FILE_TREE_RESIZE_STEP = 16

export function computeMaxCombinedDiffFileTreeWidth(containerWidth: number): number {
  // Why: a hidden pane measures 0; treat that as "unknown" so it can't shrink the stored width.
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return COMBINED_DIFF_FILE_TREE_MAX_WIDTH
  }

  return Math.min(
    COMBINED_DIFF_FILE_TREE_MAX_WIDTH,
    Math.max(
      COMBINED_DIFF_FILE_TREE_MIN_WIDTH,
      containerWidth - COMBINED_DIFF_FILE_TREE_MIN_DIFF_WIDTH
    )
  )
}

export function clampCombinedDiffFileTreeWidth(
  width: unknown,
  containerWidth?: number,
  fallback = COMBINED_DIFF_FILE_TREE_DEFAULT_WIDTH
): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return fallback
  }

  const maxWidth =
    containerWidth !== undefined
      ? computeMaxCombinedDiffFileTreeWidth(containerWidth)
      : COMBINED_DIFF_FILE_TREE_MAX_WIDTH

  return Math.min(maxWidth, Math.max(COMBINED_DIFF_FILE_TREE_MIN_WIDTH, width))
}
