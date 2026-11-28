const RTL_LETTER =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u
const LETTER = /\p{L}/u
// Punctuation splits words too (`Hello,مرحبا`), except what joins one path or identifier.
const WORD_BREAK = /(?:\s|(?![./_:@#\\-])\p{P})+/u

export type TextDirection = 'ltr' | 'rtl'

/**
 * The direction most of the words read in, ties going to the first. Unlike the browser's
 * first-letter rule, an Arabic sentence that opens with `React` or `Claude` stays right-to-left.
 */
export function dominantTextDirection(text: string): TextDirection | undefined {
  let rtl = 0
  let ltr = 0
  let first: TextDirection | undefined
  for (const word of text.split(WORD_BREAK)) {
    const letter = LETTER.exec(word)?.[0]
    if (!letter) {
      continue
    }
    const direction = RTL_LETTER.test(letter) ? 'rtl' : 'ltr'
    first ??= direction
    if (direction === 'rtl') {
      rtl++
    } else {
      ltr++
    }
  }
  return rtl === ltr ? first : rtl > ltr ? 'rtl' : 'ltr'
}
