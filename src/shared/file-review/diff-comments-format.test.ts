import { describe, expect, it } from 'vitest'
import { formatDiffComments } from './diff-comments-format'

describe('formatDiffComments', () => {
  it('sends the text a markdown range note was left on', () => {
    expect(
      formatDiffComments([
        {
          id: 'n1',
          worktreeId: 'w1',
          filePath: 'docs/design.md',
          source: 'markdown',
          selectedText: 'App publishing changes\nwhile it is in flight',
          startLine: 105,
          lineNumber: 115,
          body: 'Explain this',
          createdAt: 1,
          side: 'modified'
        }
      ])
    ).toBe(
      [
        'File: docs/design.md',
        'Source: markdown',
        'Lines: 105-115',
        'Excerpt:',
        '> App publishing changes',
        '> while it is in flight',
        'User comment: "Explain this"'
      ].join('\n')
    )
  })
})
