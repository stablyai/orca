import { afterEach, describe, expect, it, vi } from 'vitest'
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

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it('extracts CRLF annotated markdown lines without splitting the full document', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const excerpt = getMarkdownReviewExcerpt(
      'one\r\ntwo\r\nthree',
      note({ startLine: 2, lineNumber: 3 })
    )

    expect(excerpt).toBe('> two\n> three')
    expect(split).not.toHaveBeenCalled()
  })

  it('collapses long annotated ranges while retaining leading and trailing context', () => {
    const excerpt = getMarkdownReviewExcerpt(
      Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n'),
      note({ startLine: 1, lineNumber: 12 })
    )

    expect(excerpt).toBe(
      [
        '> line 1',
        '> line 2',
        '> line 3',
        '> line 4',
        '> ...',
        '> line 9',
        '> line 10',
        '> line 11',
        '> line 12'
      ].join('\n')
    )
  })

  it('stops after the requested line range in large pasted markdown content', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')
    const content = ['one', 'two', 'three', 'x'.repeat(100_000)].join('\n')

    expect(getMarkdownReviewExcerpt(content, note({ startLine: 2, lineNumber: 3 }))).toBe(
      '> two\n> three'
    )

    expect(split).not.toHaveBeenCalled()
    expect(charCodeAt.mock.calls.length).toBeLessThan(64)
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
    expect(formatMarkdownReviewCardQuote('a'.repeat(120))).toBe(`${'a'.repeat(57)}...`)
  })

  it('bounds card quote normalization for large pasted selected text', () => {
    const replace = vi.spyOn(String.prototype, 'replace')
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')
    const text = `  ${'a'.repeat(30)}\n${'b'.repeat(30)} ${'c'.repeat(100_000)}`

    expect(formatMarkdownReviewCardQuote(text)).toBe(`${'a'.repeat(30)} ${'b'.repeat(26)}...`)
    expect(charCodeAt.mock.calls.length).toBeLessThan(96)
    expect(
      replace.mock.calls.filter(
        ([pattern]) => pattern instanceof RegExp && pattern.source === '\\s+'
      )
    ).toHaveLength(0)
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
        '',
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

  it('formats large exact selected text without splitting it into arrays', () => {
    const selectedText = `alpha\r\nbeta\n${'gamma '.repeat(1000)}`
    const split = vi.spyOn(String.prototype, 'split')

    const formatted = formatMarkdownReviewNotes(
      [note({ selectedText, lineNumber: 2, body: 'reword this' })],
      'one\nignored source'
    )

    expect(formatted).toContain('Excerpt:\n> alpha\n> beta\n> gamma')
    expect(split).not.toHaveBeenCalled()
  })

  it('groups multiple notes for one markdown file under a single header', () => {
    const formatted = formatMarkdownReviewNotes(
      [
        note({ id: 'a', lineNumber: 2, body: 'is this part of the command?' }),
        note({ id: 'b', lineNumber: 3, body: 'what are these fields?' })
      ],
      'one\ntwo\nthree'
    )

    expect(formatted).toBe(
      [
        'File: README.md',
        'Source: markdown',
        '',
        'Line 2',
        'Excerpt:',
        '> two',
        'User comment: "is this part of the command?"',
        '',
        'Line 3',
        'Excerpt:',
        '> three',
        'User comment: "what are these fields?"'
      ].join('\n')
    )
  })
})
