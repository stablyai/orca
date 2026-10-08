import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getMarkdownRichModeUnsupportedReason } from './markdown-rich-mode'
import { getRichMarkdownRoundTripOutput } from './markdown-round-trip'

vi.mock('./markdown-round-trip', () => ({
  getRichMarkdownRoundTripOutput: vi.fn((content: string) => content)
}))
beforeEach(() =>
  vi
    .mocked(getRichMarkdownRoundTripOutput)
    .mockReset()
    .mockImplementation((text) => text)
)
afterEach(() => vi.restoreAllMocks())

describe('rich Markdown comment scanning', () => {
  it.each([
    ['plain <placeholder>', null],
    ['<!--unclosed<!--again', null],
    ['<!--->', null],
    ['<!---->', 'html-or-jsx'],
    ['<!--outer<!--inner-->tail', 'html-or-jsx'],
    ['<!--unclosed<span>text</span>', 'html-or-jsx'],
    ['<custom x="<!--complete-->">', 'html-or-jsx'],
    ['`<!--complete-->`', null],
    ['```html\n<!--complete-->\n```', null],
    ['<!--complete-->\n[a]: https://example.com', 'reference-links'],
    ['<!--complete-->\n[^a]: footnote', 'reference-links']
  ] as const)('preserves the decision for %j', (content, expected) => {
    vi.mocked(getRichMarkdownRoundTripOutput).mockReturnValue(null)
    expect(getMarkdownRichModeUnsupportedReason(content)).toBe(expected)
  })

  it('does not pass unclosed comment openers through a comment regex', () => {
    const input = '<!--x'.repeat(8000)
    const matchAll = vi.spyOn(String.prototype, 'matchAll')
    const result = getMarkdownRichModeUnsupportedReason(input)
    const commentScans = matchAll.mock.calls.filter(
      ([pattern]) => pattern instanceof RegExp && pattern.source.includes('<!--')
    ).length
    expect(result).toBeNull()
    expect(commentScans).toBe(0)
    expect(getRichMarkdownRoundTripOutput).not.toHaveBeenCalled()
  })

  it('continues preserving tags after unmatched comments without repeated closer searches', () => {
    const input = `<span>before</span>${'<!--x'.repeat(8000)}<b>after</b>`
    const indexOf = vi.spyOn(String.prototype, 'indexOf')
    const includes = vi.spyOn(String.prototype, 'includes')
    const result = getMarkdownRichModeUnsupportedReason(input)
    const closerSearches = [...indexOf.mock.calls, ...includes.mock.calls].filter(
      ([needle]) => needle === '-->'
    ).length
    expect(result).toBeNull()
    expect(closerSearches).toBeLessThanOrEqual(1)
    vi.mocked(getRichMarkdownRoundTripOutput).mockReturnValue(
      input.replace('<b>after</b>', 'after')
    )
    expect(getMarkdownRichModeUnsupportedReason(input)).toBe('html-or-jsx')
  })
})
