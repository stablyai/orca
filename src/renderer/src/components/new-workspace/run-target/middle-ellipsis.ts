// A long label shortened in the middle, keeping as much of its start and end as fit, evenly.

const ELLIPSIS = '…'

/** `text`, or its start and end around "…", the longest that `fits`; the end gets the odd character. */
export function middleEllipsis(text: string, fits: (candidate: string) => boolean): string {
  if (fits(text)) {
    return text
  }
  const shortened = (kept: number): string =>
    text.slice(0, Math.floor(kept / 2)) + ELLIPSIS + text.slice(text.length - Math.ceil(kept / 2))
  // Binary search on the characters kept: fitting only shrinks as more are kept.
  let low = 0
  let high = text.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (fits(shortened(mid))) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  return shortened(low)
}
