// Japanese and Chinese run on after a full-width terminator; any other sentence takes a space.
const RUNS_ON_AFTER = /[。！？]$/

/** Whole sentences as one passage. Each gap follows the sentence before it, not the UI language, so
 *  a sentence a language pack left in English keeps its space beside translated ones. */
export function joinSentences(sentences: readonly string[]): string {
  return sentences
    .map((sentence, index) =>
      index === 0 || RUNS_ON_AFTER.test(sentences[index - 1]) ? sentence : ` ${sentence}`
    )
    .join('')
}
