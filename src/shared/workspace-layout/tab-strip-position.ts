/** Where a workspace's tabs render: the horizontal strip above each split, or a vertical list to its left. */
export type TabStripPosition = 'top' | 'left'

export const DEFAULT_TAB_STRIP_POSITION: TabStripPosition = 'top'

export type TabStripPositionSettings = {
  tabStripPosition?: TabStripPosition
}

export function normalizeTabStripPosition(value: unknown): TabStripPosition {
  return value === 'left' ? 'left' : DEFAULT_TAB_STRIP_POSITION
}

export const VERTICAL_TAB_LIST_MIN_WIDTH = 160
export const VERTICAL_TAB_LIST_DEFAULT_WIDTH = 240
export const VERTICAL_TAB_LIST_MAX_WIDTH = 480
/** Icons-only width: one 32px row plus the list's 4px gutters. */
export const VERTICAL_TAB_LIST_COLLAPSED_WIDTH = 40

export function clampVerticalTabListWidth(
  width: unknown,
  fallback = VERTICAL_TAB_LIST_DEFAULT_WIDTH
): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return fallback
  }
  return Math.round(
    Math.min(VERTICAL_TAB_LIST_MAX_WIDTH, Math.max(VERTICAL_TAB_LIST_MIN_WIDTH, width))
  )
}
