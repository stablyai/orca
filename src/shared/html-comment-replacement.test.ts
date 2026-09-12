import { afterEach, describe, expect, it, vi } from 'vitest'
import { replaceHtmlComments } from './html-comment-replacement'

afterEach(() => vi.restoreAllMocks())

describe('HTML comment replacement', () => {
  it.each(['', ' '] as const)('matches the regex with replacement %j', (replacement) => {
    const fragments = [
      '',
      'a',
      '\r\n',
      '😀',
      '<!--',
      '-->',
      '<!---->',
      '<!--->',
      '<!--x-->',
      '<!--x'
    ]
    for (const first of fragments) {
      for (const second of fragments) {
        for (const third of fragments) {
          const input = first + second + third
          expect(replaceHtmlComments(input, replacement)).toBe(
            input.replace(/<!--[\s\S]*?-->/g, replacement)
          )
        }
      }
    }
  })

  it('keeps an unmatched suffix out of the regex scan', () => {
    const prefix = 'a<!--complete-->'
    const suffix = `b${'<!--unfinished'.repeat(8000)}`
    const replace = vi.spyOn(String.prototype, 'replace')
    const actual = replaceHtmlComments(prefix + suffix, ' ')
    const scanned = [...replace.mock.contexts]
    replace.mockRestore()
    expect(actual).toBe(`a ${suffix}`)
    expect(scanned).toEqual([prefix])
  })

  it('skips the regex entirely when there are no closing markers', () => {
    const input = '<!--x'.repeat(8000)
    const replace = vi.spyOn(String.prototype, 'replace')
    const actual = replaceHtmlComments(input)
    const scans = replace.mock.calls.length
    replace.mockRestore()
    expect(actual).toBe(input)
    expect(scans).toBe(0)
  })
})
