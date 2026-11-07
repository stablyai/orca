import { describe, expect, it } from 'vitest'
import { dictationSeparators } from './dictation-transcript-spacing'

const place = (before: string, text: string, after: string): string => {
  const { leading, trailing } = dictationSeparators(before, text, after)
  return `${before}${leading}${text}${trailing}${after}`
}

describe('dictationSeparators', () => {
  it('spaces dictated words from the words on either side', () => {
    expect(place('hello', 'world', '')).toBe('hello world')
    expect(place('fix the ', 'flaky', 'test')).toBe('fix the flaky test')
    expect(place('Hello.', 'World', '')).toBe('Hello. World')
    expect(place('hello,', 'world', '')).toBe('hello, world')
  })

  it('does not add a space before punctuation or around CJK', () => {
    expect(place('hello', '.', '')).toBe('hello.')
    expect(place('你好', '世界', '')).toBe('你好世界')
  })
})
