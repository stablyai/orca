export const MIN_SPLIT_RATIO = 0.15
export const MAX_SPLIT_RATIO = 0.85

/** Ratio the split's panes currently render, from the flex-grow values the store wrote. */
export function readSplitRatio(firstPane: HTMLElement, secondPane: HTMLElement): number | null {
  const first = Number.parseFloat(firstPane.style.flexGrow)
  const second = Number.parseFloat(secondPane.style.flexGrow)
  if (!Number.isFinite(first) || !Number.isFinite(second) || first + second <= 0) {
    return null
  }
  return first / (first + second)
}

/** Fallback when the panes carry no flex-grow ratio: the rendered size split. */
export function measureSplitRatio(
  firstPane: HTMLElement,
  secondPane: HTMLElement,
  isHorizontal: boolean
): number {
  const first = firstPane.getBoundingClientRect()
  const second = secondPane.getBoundingClientRect()
  const firstSize = isHorizontal ? first.width : first.height
  const total = firstSize + (isHorizontal ? second.width : second.height)
  return total > 0 ? firstSize / total : 0.5
}

/**
 * Keeps the seam at the same distance from the pointer as when it was grabbed: an off-center grab never
 * jumps, and the seam stays under the pointer if the container resizes or moves mid-drag.
 * A restored ratio outside the clamp never moves at zero displacement and can only move back inward.
 */
export function getDraggedSplitRatio({
  startRatio,
  startPos,
  pos,
  startContainerPos,
  containerPos,
  startAvailablePx,
  availablePx
}: {
  startRatio: number
  startPos: number
  pos: number
  startContainerPos: number
  containerPos: number
  startAvailablePx: number
  availablePx: number
}): number | null {
  if (availablePx <= 0) {
    return null
  }
  const unchanged = containerPos === startContainerPos && availablePx === startAvailablePx
  // Why: the unchanged-container branch stays exact so a zero-displacement move re-commits the stored ratio.
  const ratio = unchanged
    ? startRatio + (pos - startPos) / availablePx
    : (pos - startPos + startContainerPos - containerPos + startRatio * startAvailablePx) /
      availablePx
  const min = Math.min(MIN_SPLIT_RATIO, startRatio)
  const max = Math.max(MAX_SPLIT_RATIO, startRatio)
  return Math.min(max, Math.max(min, ratio))
}
