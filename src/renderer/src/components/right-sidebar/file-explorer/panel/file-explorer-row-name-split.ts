const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' })
const RTL_TEXT = /[֐-ࣿיִ-﷿ﹰ-﻿\u{10800}-\u{10fff}\u{1e800}-\u{1eeff}]/u
// white-space: pre would turn these into real line breaks; a whole name renders with nowrap.
const LINE_BREAKING_TEXT = /[\p{Cc}\p{Zl}\p{Zp}]/u
const WORD_START = /^[-_. ]$/
const UPPERCASE = /^\p{Lu}$/u
const LOWERCASE_OR_DIGIT = /^[\p{Ll}\p{Nd}]$/u
const MIN_TAIL_LENGTH = 8
const MAX_TAIL_LENGTH = 16
const MAX_TAIL_SHARE = 0.6

/** Splits a name so its tail, where extensions and qualifiers live, survives truncation. Whole when
 *  empty tail: names too short to split, with line breaks, or RTL, whose order two boxes would break. */
export function splitFileExplorerRowName(name: string): [head: string, tail: string] {
  if (RTL_TEXT.test(name) || LINE_BREAKING_TEXT.test(name)) {
    return [name, '']
  }
  const parts = Array.from(graphemes.segment(name), ({ segment }) => segment)
  if (parts.length <= MIN_TAIL_LENGTH) {
    return [name, '']
  }
  const tailLength = Math.min(MAX_TAIL_LENGTH, Math.floor(parts.length * MAX_TAIL_SHARE))
  const earliest = parts.length - Math.max(tailLength, MIN_TAIL_LENGTH)
  const latest = parts.length - MIN_TAIL_LENGTH
  let split = earliest
  for (let index = earliest; index <= latest; index++) {
    const isCamelHump = UPPERCASE.test(parts[index]) && LOWERCASE_OR_DIGIT.test(parts[index - 1])
    if (WORD_START.test(parts[index]) || isCamelHump) {
      split = index
      break
    }
  }
  return [parts.slice(0, split).join(''), parts.slice(split).join('')]
}
