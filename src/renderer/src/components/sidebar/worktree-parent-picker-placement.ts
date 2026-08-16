export const PICKER_ROW_HEIGHT = 56
export const PICKER_ROW_OVERSCAN = 6
export const PICKER_LIST_MAX_HEIGHT = 288
export const PICKER_VIEWPORT_PADDING = 12
// Why: input is h-10 inside a py-1 wrapper over a 1px border.
const PICKER_INPUT_HEIGHT = 49
// Why: 11px leading-none text in a py-2 row over a 1px border.
const PICKER_HEADER_HEIGHT = 28
// Why: the popover surface adds its own 1px border top and bottom.
const PICKER_SURFACE_BORDER_HEIGHT = 2

export function estimateWorktreeParentPickerHeight(candidateCount: number): number {
  const listHeight = Math.min(
    Math.max(candidateCount, 1) * PICKER_ROW_HEIGHT,
    PICKER_LIST_MAX_HEIGHT
  )
  return PICKER_SURFACE_BORDER_HEIGHT + PICKER_HEADER_HEIGHT + PICKER_INPUT_HEIGHT + listHeight
}

// Why: Radix shifts a side="right" popover along its main (horizontal) axis
// only — `crossAxis: false` — and `flip` only swaps left/right, so nothing
// corrects vertical overflow and a card low in the sidebar puts the list below
// the window. The anchor is virtual here, so lift it until the list fits.
export function clampWorktreeParentPickerAnchorTop(
  anchorTop: number,
  contentHeight: number,
  viewportHeight: number
): number {
  const maxTop = viewportHeight - PICKER_VIEWPORT_PADDING - contentHeight
  if (maxTop <= PICKER_VIEWPORT_PADDING) {
    return PICKER_VIEWPORT_PADDING
  }
  return Math.min(Math.max(anchorTop, PICKER_VIEWPORT_PADDING), maxTop)
}
