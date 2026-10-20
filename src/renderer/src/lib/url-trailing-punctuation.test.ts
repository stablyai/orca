import { describe, expect, it } from 'vitest'
import { TERMINAL_HTTP_URL_PATTERN, trimUrlTrailingPunctuation } from './url-trailing-punctuation'

function match(lineText: string): string | null {
  return lineText.match(TERMINAL_HTTP_URL_PATTERN)?.[0] ?? null
}

describe('TERMINAL_HTTP_URL_PATTERN', () => {
  it('stops at full-width punctuation hugging the url', () => {
    expect(match('投稿はお願いします（https://github.com/a/b/pull/1078）。')).toBe(
      'https://github.com/a/b/pull/1078'
    )
    expect(match('「https://github.com/a/b/pull/1」を見て')).toBe('https://github.com/a/b/pull/1')
    expect(match('詳細は https://github.com/a/b/pull/1 、こちら')).toBe(
      'https://github.com/a/b/pull/1'
    )
  })

  it('stops at an ideographic full stop with no bracket', () => {
    expect(match('詳細は https://github.com/a/b/pull/1078。')).toBe(
      'https://github.com/a/b/pull/1078'
    )
  })

  it('keeps unencoded cjk inside the url itself', () => {
    expect(match('https://ja.wikipedia.org/wiki/日本語 を参照')).toBe(
      'https://ja.wikipedia.org/wiki/日本語'
    )
  })

  it('keeps the ascii behaviour of the upstream default', () => {
    expect(match('see https://example.com/a?b=1&c=2#frag.')).toBe(
      'https://example.com/a?b=1&c=2#frag'
    )
    expect(match('(https://github.com/a/b/pull/1078)')).toBe('https://github.com/a/b/pull/1078')
    expect(match('http://localhost:3000/ ready')).toBe('http://localhost:3000/')
    expect(match('HTTPS://EXAMPLE.COM/X here')).toBe('HTTPS://EXAMPLE.COM/X')
    expect(match('no link here')).toBeNull()
  })

  it('scans a long url without catastrophic backtracking', () => {
    const line = `https://example.com/${'a/'.repeat(20000)} tail`
    const started = Date.now()
    expect(match(line)?.length).toBe(40020)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('trimUrlTrailingPunctuation', () => {
  it('drops the japanese tail gfm leaves inside the href', () => {
    expect(trimUrlTrailingPunctuation('https://github.com/a/b/pull/1078)。')).toBe(
      'https://github.com/a/b/pull/1078'
    )
    expect(trimUrlTrailingPunctuation('https://github.com/a/b/pull/1078）。')).toBe(
      'https://github.com/a/b/pull/1078'
    )
    expect(trimUrlTrailingPunctuation('https://github.com/a/b/pull/1」を見て')).toBe(
      'https://github.com/a/b/pull/1'
    )
  })

  it('keeps a balanced parenthesis that belongs to the url', () => {
    expect(trimUrlTrailingPunctuation('https://en.wikipedia.org/wiki/Foo_(bar)')).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)'
    )
    expect(trimUrlTrailingPunctuation('https://en.wikipedia.org/wiki/Foo_(bar)。')).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)'
    )
  })

  it('leaves a clean url untouched', () => {
    expect(trimUrlTrailingPunctuation('https://example.com/a?b=1&c=2#frag')).toBe(
      'https://example.com/a?b=1&c=2#frag'
    )
    expect(trimUrlTrailingPunctuation('https://ja.wikipedia.org/wiki/日本語')).toBe(
      'https://ja.wikipedia.org/wiki/日本語'
    )
  })

  it('strips stacked ascii trailing punctuation', () => {
    expect(trimUrlTrailingPunctuation('https://example.com/a).,')).toBe('https://example.com/a')
  })
})
