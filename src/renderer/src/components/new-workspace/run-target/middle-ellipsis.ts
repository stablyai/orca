// A long label shortened in the middle, keeping as much of its start and end as fit, evenly. It cuts
// between graphemes, so an emoji or an accented letter is never split.

import { getIntlLocale } from '@/i18n/i18n'

const ELLIPSIS = '…'

function graphemes(text: string): string[] {
  const segmenter = new Intl.Segmenter(getIntlLocale(), { granularity: 'grapheme' })
  return Array.from(segmenter.segment(text), (part) => part.segment)
}

/** `text`, or its start and end around "…", the longest that `fits`; the end gets the odd grapheme. */
export function middleEllipsis(text: string, fits: (candidate: string) => boolean): string {
  if (fits(text)) {
    return text
  }
  const parts = graphemes(text)
  const shortened = (kept: number): string =>
    parts.slice(0, Math.floor(kept / 2)).join('') +
    ELLIPSIS +
    parts.slice(parts.length - Math.ceil(kept / 2)).join('')
  // Binary search on the graphemes kept: fitting only shrinks as more are kept.
  let low = 0
  let high = parts.length - 1
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
