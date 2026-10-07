// Why: serialization drops ratios this close to 0.5, so an apply within it must not write either.
export const SPLIT_RATIO_TOLERANCE = 0.005

/** First child's share of a split, read from the two children's flex-grow. */
export function readSplitRatio(first: HTMLElement, second: HTMLElement): number {
  const firstGrow = Number.parseFloat(first.style.flex) || 1
  const secondGrow = Number.parseFloat(second.style.flex) || 1
  const total = firstGrow + secondGrow
  return total > 0 ? firstGrow / total : 0.5
}
