// Japanese and Chinese run on after a full-width terminator; any other sentence takes a space.
const RUNS_ON_AFTER = /[\u3002\uFF01\uFF1F]$/
const CJK_TEXT = /[\u3040-\u30FF\u3400-\u9FFF\uF900-\uFAFF]/u
const ENDS_IN_PUNCTUATION = /[\p{P}\p{S}]$/u
// Why: CJK closers and curly quotes only; ASCII ' " ) ] keep their space so an ASCII-quoted CJK value in English text isn't stopped.
const CLOSERS = new Set('”’」』）】》〉')

// Why: a loop, not /[…]+$/, which backtracks quadratically on a long closer run that isn't at the end.
function withoutTrailingClosers(text: string): string {
  let end = text.length
  while (end > 0 && CLOSERS.has(text[end - 1])) {
    end--
  }
  return text.slice(0, end)
}

// Why: a CJK sentence whose catalog value drops its final stop still ends there, so it gets 。, not a space.
function separatorAfter(previous: string): string {
  const text = withoutTrailingClosers(previous)
  if (RUNS_ON_AFTER.test(text)) {
    return ''
  }
  // Why: a closer hides the stop only when CJK text ends inside it, so "…（/Users/张三/repo）" keeps its space.
  const ending = text === previous ? previous : text.slice(-1)
  return CJK_TEXT.test(ending) && !ENDS_IN_PUNCTUATION.test(text) ? '。' : ' '
}

/** Stop a caller appends to a sentence it styles apart from the next one: 。 after CJK text, "." otherwise. */
export function sentenceStop(sentence: string): string {
  if (ENDS_IN_PUNCTUATION.test(sentence)) {
    return ''
  }
  return CJK_TEXT.test(sentence) ? '。' : '.'
}

/** Stop for text that ends a sentence built in code: none after CJK text, whose zh copy drops final stops; "." otherwise. */
export function finalSentenceStop(sentence: string): string {
  return ENDS_IN_PUNCTUATION.test(sentence) || CJK_TEXT.test(sentence) ? '' : '.'
}

/** Use each preceding sentence’s language, not UI locale, so English fallback text keeps its space beside translations. */
export function joinSentences(sentences: readonly string[]): string {
  let joined = ''
  let previous: string | null = null
  for (const sentence of sentences) {
    if (sentence === '') {
      continue
    }
    joined += previous === null ? sentence : `${separatorAfter(previous)}${sentence}`
    previous = sentence
  }
  return joined
}
