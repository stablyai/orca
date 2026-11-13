// Japanese and Chinese run on after a full-width terminator; any other sentence takes a space.
const RUNS_ON_AFTER = /[\u3002\uFF01\uFF1F]$/
const CJK_TEXT = /[\u3040-\u30FF\u3400-\u9FFF\uF900-\uFAFF]/u
const ENDS_IN_PUNCTUATION = /[\p{P}\p{S}]$/u

// Why: a CJK sentence whose catalog value drops its final stop still ends there, so it gets 。, not a space.
function separatorAfter(previous: string): string {
  if (RUNS_ON_AFTER.test(previous)) {
    return ''
  }
  return CJK_TEXT.test(previous) && !ENDS_IN_PUNCTUATION.test(previous) ? '。' : ' '
}

/** Stop a caller appends to a sentence it styles apart from the next one: 。 after CJK text, "." otherwise. */
export function sentenceStop(sentence: string): string {
  if (ENDS_IN_PUNCTUATION.test(sentence)) {
    return ''
  }
  return CJK_TEXT.test(sentence) ? '。' : '.'
}

/** Use each preceding sentence’s language, not UI locale, so English fallback text keeps its space beside translations. */
export function joinSentences(sentences: readonly string[]): string {
  return sentences
    .map((sentence, index) =>
      index === 0 ? sentence : `${separatorAfter(sentences[index - 1])}${sentence}`
    )
    .join('')
}
