// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import { useRichMarkdownReviewData } from './useRichMarkdownReviewData'

const existingNote: DiffComment = {
  id: 'n1',
  worktreeId: 'wt1',
  filePath: 'README.md',
  source: 'markdown',
  lineNumber: 1,
  body: 'needs detail',
  createdAt: 0,
  side: 'modified'
}

function renderReviewData(markdownAnnotationsEnabled: boolean) {
  return renderHook(() =>
    useRichMarkdownReviewData({
      allDiffComments: [existingNote],
      filePath: '/repo/README.md',
      markdownAnnotationsEnabled,
      markdownReviewContent: '# Readme\n',
      worktreeRoot: '/repo'
    })
  ).result.current
}

describe('useRichMarkdownReviewData', () => {
  it('surfaces existing notes when review tools are enabled', () => {
    const review = renderReviewData(true)
    expect(review.canAnnotateRichMarkdown).toBe(true)
    expect(review.markdownComments).toEqual([existingNote])
    expect(review.unsentMarkdownReviewScope[0].notes).toHaveLength(1)
  })

  it('hides existing notes and their send scope when review tools are disabled', () => {
    const review = renderReviewData(false)
    expect(review.canAnnotateRichMarkdown).toBe(false)
    expect(review.markdownComments).toEqual([])
    expect(review.markdownReviewNotes).toEqual([])
    expect(review.unsentMarkdownReviewScope[0].notes).toEqual([])
  })
})
