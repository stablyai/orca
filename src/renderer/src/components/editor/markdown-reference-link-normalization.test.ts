import { afterEach, describe, expect, it, vi } from 'vitest'
import { marked } from 'marked'
import { normalizeMarkdownReferenceLinks } from './markdown-reference-link-normalization'

// Offsets marked itself treats as fenced code, so the sweep below compares the
// normalizer against the parser that decides what the file really means.
function markedCodeRanges(markdown: string): [number, number][] {
  const ranges: [number, number][] = []
  let offset = 0
  for (const token of marked.lexer(markdown.replace(/\r\n|\r/g, '\n'))) {
    if (token.type === 'code') {
      ranges.push([offset, offset + token.raw.length])
    }
    offset += token.raw.length
  }
  return ranges
}

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

  it('never removes a definition marked keeps inside a fenced code block', () => {
    const definition = '[docs]: https://example.com/docs'
    const survivors: string[] = []
    for (const outer of ['```', '````', '~~~', '~~~~']) {
      // Fence-shaped lines that do and do not close `outer`.
      for (const inner of ['```', '````', '~~~', '````js', '``` ', '```` trailing', '~~~a`b']) {
        const markdown = `${outer}\ncode\n${inner}\n${definition}\n[Docs]\n${outer}\n`
        const offset = markdown.indexOf(definition)
        const insideCode = markedCodeRanges(markdown).some(
          ([start, end]) => offset >= start && offset < end
        )
        if (insideCode && !normalizeMarkdownReferenceLinks(markdown).includes(definition)) {
          survivors.push(markdown)
        }
      }
    }
    expect(survivors).toEqual([])
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
