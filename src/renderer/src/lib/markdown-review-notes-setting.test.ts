import { describe, expect, it } from 'vitest'
import type { DiffComment } from '../../../shared/diff-comment-types'
import {
  isMarkdownReviewNotesEnabled,
  withoutMarkdownReviewNotes
} from './markdown-review-notes-setting'

function note(id: string, source?: DiffComment['source']): DiffComment {
  return {
    id,
    worktreeId: 'wt-1',
    filePath: 'README.md',
    lineNumber: 1,
    body: id,
    createdAt: 0,
    side: 'modified',
    ...(source ? { source } : {})
  }
}

describe('isMarkdownReviewNotesEnabled', () => {
  it('only treats an explicit false as off', () => {
    expect(isMarkdownReviewNotesEnabled(null)).toBe(true)
    expect(isMarkdownReviewNotesEnabled({ markdownReviewToolsEnabled: true })).toBe(true)
    expect(isMarkdownReviewNotesEnabled({ markdownReviewToolsEnabled: false })).toBe(false)
  })
})

describe('withoutMarkdownReviewNotes', () => {
  it('drops markdown notes and keeps diff notes', () => {
    const comments = [note('diff'), note('md', 'markdown'), note('legacy-diff', 'diff')]
    expect(withoutMarkdownReviewNotes(comments).map((c) => c.id)).toEqual(['diff', 'legacy-diff'])
  })

  it('returns the same array when there is nothing to drop', () => {
    const comments = [note('diff')]
    expect(withoutMarkdownReviewNotes(comments)).toBe(comments)
  })
})
