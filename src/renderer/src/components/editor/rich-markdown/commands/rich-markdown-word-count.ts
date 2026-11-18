const segmenters = new Map<string, Intl.Segmenter>()

function segmenterFor(locale: string): Intl.Segmenter {
  let segmenter = segmenters.get(locale)
  if (!segmenter) {
    segmenter = new Intl.Segmenter(locale, { granularity: 'word' })
    segmenters.set(locale, segmenter)
  }
  return segmenter
}

/** Count word-like segments; whitespace splitting miscounts CJK and keeps punctuation. */
export function countWords(text: string, locale: string): number {
  let count = 0
  for (const { isWordLike } of segmenterFor(locale).segment(text)) {
    if (isWordLike) {
      count += 1
    }
  }
  return count
}
