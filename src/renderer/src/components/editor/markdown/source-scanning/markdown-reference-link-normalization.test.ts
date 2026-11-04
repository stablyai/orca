import { afterEach, describe, expect, it, vi } from 'vitest'

import { normalizeMarkdownReferenceLinks } from './markdown-reference-link-normalization'

// Use marked’s own fence ranges as an independent oracle for normalization boundaries.

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

  it('ignores definitions inside fenced code blocks', () => {
    const markdown = ['```md', '[docs]: https://example.com/docs', '```', '', '[Docs]'].join('\n')

    expect(normalizeMarkdownReferenceLinks(markdown)).toBe(markdown)
  })
})
