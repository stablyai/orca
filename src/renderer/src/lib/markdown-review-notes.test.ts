import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../shared/diff-comment-types'
import {
  formatMarkdownReviewNotes,
  getMarkdownReviewExcerpt,
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
  it('preserves empty, trailing, and mixed line endings across excerpt ranges', () => {
    for (const content of [
      '',
      'one',
      '\n',
      'one\n',
      'one\r\n\r\ntwo\r',
      'one\rtwo',
      Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n')
    ]) {
      const sourceLines = content
        .split('\n')
        .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
      for (let start = -1; start <= sourceLines.length + 1; start += 1) {
        for (let end = start; end <= sourceLines.length + 1; end += 1) {
          const first = Math.max(1, start)
          const selected = sourceLines.slice(first - 1, Math.max(first, end))
          const bounded =
            selected.length <= 8
              ? selected
              : [...selected.slice(0, 4), '...', ...selected.slice(-4)]
          expect(
            getMarkdownReviewExcerpt(content, note({ startLine: start, lineNumber: end }))
          ).toBe(bounded.map((line) => `> ${line}`).join('\n'))
        }
      }
    }
  })

  it('formats exact selected text when available', () => {
    const formatted = formatMarkdownReviewNotes(
      [note({ selectedText: 'specific phrase', lineNumber: 2, body: 'reword this' })],
      'one\nspecific phrase in a longer line'
    )

    expect(formatted).toContain('Excerpt:\n> specific phrase')
  })
})
