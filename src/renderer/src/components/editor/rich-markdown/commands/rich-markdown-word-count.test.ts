import { describe, expect, it } from 'vitest'
import { countWords } from './rich-markdown-word-count'

describe('countWords', () => {
  it.each([
    ['hello world', 'en', 2],
    ['one, two.', 'en', 2],
    ["don't stop", 'en', 2],
    ['  ', 'en', 0],
    ['你好世界', 'zh', 2]
  ])('counts %j in %s as %i words', (text, locale, expected) => {
    expect(countWords(text, locale)).toBe(expected)
  })
})
