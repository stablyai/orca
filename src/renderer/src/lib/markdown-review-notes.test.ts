import { describe, expect, it } from 'vitest'
import type { DiffComment } from '../../../shared/types'
import {
  formatMarkdownReviewNotes,
  getMarkdownReviewExcerpt,
  sortMarkdownReviewNotes,
  type MarkdownReviewNote
} from './markdown-review-notes'

function note(overrides: Partial<Omit<DiffComment, 'source'>> = {}): MarkdownReviewNote {
  return {
    id: 'n1',
    worktreeId: 'wt1',
    filePath: 'README.md',
    source: 'markdown',
    lineNumber: 2,
    body: 'needs detail',
    createdAt: 0,
    side: 'modified',
    ...overrides
  }
}

describe('markdown review notes', () => {
  it('sorts by file path, source line, then creation time', () => {
    const sorted = sortMarkdownReviewNotes([
      note({ id: 'later', lineNumber: 4, createdAt: 2 }),
      note({ id: 'other-file', filePath: 'docs/a.md', lineNumber: 10 }),
      note({ id: 'earlier', lineNumber: 4, createdAt: 1 }),
      note({ id: 'first', lineNumber: 1 })
    ])

    expect(sorted.map((item) => item.id)).toEqual(['other-file', 'first', 'earlier', 'later'])
  })

  it('extracts the annotated markdown lines as quoted context', () => {
    const excerpt = getMarkdownReviewExcerpt(
      'one\ntwo\nthree',
      note({ startLine: 2, lineNumber: 3 })
    )

    expect(excerpt).toBe('> two\n> three')
  })

  it('formats a deterministic prompt for terminal agents', () => {
    const formatted = formatMarkdownReviewNotes(
      [note({ startLine: 2, lineNumber: 3, body: 'replace "maybe"\nwith specifics' })],
      'one\ntwo\nthree'
    )

    expect(formatted).toBe(
      [
        'File: README.md',
        'Source: markdown',
        'Lines 2-3',
        'Excerpt:',
        '> two',
        '> three',
        'User comment: "replace \\"maybe\\"\\nwith specifics"'
      ].join('\n')
    )
  })
})
