// Japanese and Chinese run on after a full-width terminator; any other sentence takes a space.
const RUNS_ON_AFTER = /[\u3002\uFF01\uFF1F]$/

/** Use each preceding sentence’s language, not UI locale, so English fallback text keeps its space beside translations. */
export function joinSentences(sentences: readonly string[]): string {
  return sentences
    .map((sentence, index) =>
      index === 0 || RUNS_ON_AFTER.test(sentences[index - 1]) ? sentence : ` ${sentence}`
    )
    .join('')
}
