import { describe, expect, it } from 'vitest'
import { getMarkdownDocLinkDecorationRanges } from './monaco-markdown-doc-link-decorations'

describe('getMarkdownDocLinkDecorationRanges', () => {
  it('returns Monaco ranges for valid doc links', () => {
    expect(getMarkdownDocLinkDecorationRanges('link to [[other.md]]')).toEqual([
      {
        startLineNumber: 1,
        startColumn: 9,
        endLineNumber: 1,
        endColumn: 21
      }
    ])
  })

  it('ignores unsupported doc link syntax', () => {
    expect(getMarkdownDocLinkDecorationRanges('[[doc|Label]] [[bad [target]] [[]]')).toEqual([])
  })

  it('ignores doc links inside inline and fenced code', () => {
    expect(
      getMarkdownDocLinkDecorationRanges('`[[inline]]`\n\n```md\n[[fenced]]\n```\n[[real]]')
    ).toEqual([
      {
        startLineNumber: 6,
        startColumn: 1,
        endLineNumber: 6,
        endColumn: 9
      }
    ])
  })
})
