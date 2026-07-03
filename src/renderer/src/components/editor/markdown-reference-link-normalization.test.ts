import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeMarkdownReferenceLinks } from './markdown-reference-link-normalization'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('normalizeMarkdownReferenceLinks', () => {
  it('inlines shortcut and full reference links', () => {
    expect(
      normalizeMarkdownReferenceLinks(
        '[Docs]\n[Issue][ticket]\n\n[docs]: https://example.com/docs\n[ticket]: https://example.com/issue "Issue"'
      )
    ).toBe('[Docs](https://example.com/docs)\n[Issue](https://example.com/issue "Issue")\n\n')
  })

  it('supports CRLF reference definitions', () => {
    expect(
      normalizeMarkdownReferenceLinks('[Docs]\r\n\r\n[docs]: https://example.com/docs\r\n')
    ).toBe('[Docs](https://example.com/docs)\r\n\r\n')
  })

  it('ignores definitions inside fenced code blocks', () => {
    const markdown = ['```md', '[docs]: https://example.com/docs', '```', '', '[Docs]'].join('\n')

    expect(normalizeMarkdownReferenceLinks(markdown)).toBe(markdown)
  })

  it('scans newline-heavy documents without splitting into line arrays', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const body = Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`).join('\n')
    const markdown = `${body}\n\n[Docs]\n\n[docs]: https://example.com/docs\n`

    const normalized = normalizeMarkdownReferenceLinks(markdown)

    expect(normalized).toContain('[Docs](https://example.com/docs)')
    expect(split).not.toHaveBeenCalled()
  })

  it('folds whitespace-heavy reference labels without full whitespace replacement', () => {
    const replace = vi.spyOn(String.prototype, 'replace')
    const nonBreakingSpace = String.fromCharCode(160)
    const labelParts = Array.from({ length: 300 }, (_, index) => `PastedLabel${index}`)
    const usageLabel = labelParts.join(' ')
    const definitionLabel = ` \t${labelParts.join(` \t  ${nonBreakingSpace}`)}${nonBreakingSpace} `
    const markdown = `[Docs][${usageLabel}]\n\n[${definitionLabel}]: https://example.com/docs\n`

    expect(normalizeMarkdownReferenceLinks(markdown)).toBe('[Docs](https://example.com/docs)\n\n')
    expect(
      replace.mock.calls.filter(
        ([pattern]) => pattern instanceof RegExp && pattern.source === '\\s+'
      )
    ).toHaveLength(0)
  })
})
