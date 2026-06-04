import { describe, expect, it } from 'vitest'
import type { DiffComment } from '../../../shared/types'
import {
  formatMarkdownReviewCardQuote,
  formatMarkdownReviewNotes,
  getMarkdownReviewCardQuote,
  getMarkdownReviewExcerpt,
  getMarkdownReviewHighlightedText,
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

  it('prefers exact selected text for card highlights', () => {
    const highlighted = getMarkdownReviewHighlightedText(
      'one\ntwo broad line\nthree',
      note({ selectedText: 'broad' })
    )

    expect(highlighted).toBe('broad')
  })

  it('falls back to unquoted line context for card highlights', () => {
    const highlighted = getMarkdownReviewHighlightedText(
      'one\ntwo\nthree',
      note({ startLine: 2, lineNumber: 3 })
    )

    expect(highlighted).toBe('two\nthree')
  })

  it('normalizes card quote text into a short single-line preview', () => {
    expect(formatMarkdownReviewCardQuote('  Hiring\nupdate   for the team  ')).toBe(
      'Hiring update for the team'
    )
    expect(
      getMarkdownReviewCardQuote('one\ntwo broad line\nthree', note({ selectedText: 'broad' }))
    ).toBe('broad')
    expect(formatMarkdownReviewCardQuote('a'.repeat(120))).toBe(`${'a'.repeat(93)}...`)
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

  it('formats exact selected text when available', () => {
    const formatted = formatMarkdownReviewNotes(
      [note({ selectedText: 'specific phrase', lineNumber: 2, body: 'reword this' })],
      'one\nspecific phrase in a longer line'
    )

    expect(formatted).toContain('Excerpt:\n> specific phrase')
  })
})
