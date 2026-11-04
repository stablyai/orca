import { describe, expect, it } from 'vitest'
import { getMarkdownDocLinkDecorationRanges } from './monaco-markdown-doc-link-decorations'

describe('getMarkdownDocLinkDecorationRanges', () => {
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
