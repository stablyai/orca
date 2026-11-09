type Word = { key: string; end: number }

// Long enough that a match is the landed text, not a common phrase; short enough to survive a re-decode's small differences.
const ANCHOR_WORDS = [5, 4, 3]

// Transcripts aren't in the UI language; word breaks only need to be language-neutral.
const segmenter = new Intl.Segmenter('und', { granularity: 'word' })

/** Words compared case- and punctuation-blind, each with where it ends in the original text. */
function readWords(text: string): Word[] {
  const words: Word[] = []
  for (const part of segmenter.segment(text)) {
    const key = part.segment.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    if (part.isWordLike && key) {
      words.push({ key, end: part.index + part.segment.length })
    }
  }
  return words
}

function endsAt(words: Word[], anchor: Word[], end: number): boolean {
  return anchor.every((word, index) => words[end - anchor.length + index]?.key === word.key)
}

/**
 * A retry re-transcribes the whole recording, so its start repeats what already landed.
 * Returns what comes after the landed text's last words; with no confident match, all of it.
 */
export function trimLandedOverlap(
  landed: string,
  retried: string
): { text: string; matched: boolean } {
  const landedWords = readWords(landed)
  if (landedWords.length === 0) {
    return { text: retried.trim(), matched: true }
  }
  const retriedWords = readWords(retried)
  const sizes = ANCHOR_WORDS.filter((size) => size <= landedWords.length)
  for (const size of sizes.length > 0 ? sizes : [landedWords.length]) {
    const anchor = landedWords.slice(-size)
    let best: number | null = null
    for (let end = size; end <= retriedWords.length; end += 1) {
      // Several matches: the one nearest where the landed text should end wins.
      if (
        endsAt(retriedWords, anchor, end) &&
        (best === null || Math.abs(end - landedWords.length) < Math.abs(best - landedWords.length))
      ) {
        best = end
      }
    }
    if (best !== null) {
      const cut = retriedWords[best - 1].end
      return {
        text: retried
          .slice(cut)
          .replace(/^[^\p{L}\p{N}]+/u, '')
          .trim(),
        matched: true
      }
    }
  }
  return { text: retried.trim(), matched: false }
}
