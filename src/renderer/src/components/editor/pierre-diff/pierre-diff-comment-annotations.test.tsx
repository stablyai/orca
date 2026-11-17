import { isValidElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { DecoratedDiffComment } from '../../diff-comments/decorated-diff-comment'
import {
  buildPierreDiffCommentAnnotations,
  renderPierreDiffCommentAnnotation
} from './pierre-diff-comment-annotations'

vi.mock('../../diff-comments/DiffCommentCard', () => ({ DiffCommentCard: () => null }))
vi.mock('../../diff-comments/DiffCommentDraftCard', () => ({ DiffCommentDraftCard: () => null }))
vi.mock('../../diff-comments/DiffCommentPopover', () => ({ DiffCommentPopover: () => null }))
vi.mock('@/components/editor/review-note-delivery/NotesSendMenu', () => ({
  NotesSendMenu: () => null
}))

const note = (filePath: string): DecoratedDiffComment => ({
  id: filePath,
  filePath,
  worktreeId: 'review',
  lineNumber: 2,
  body: 'review comment',
  createdAt: 1,
  side: 'modified'
})

describe('Pierre review annotations', () => {
  it('keeps comments for other PR files out of this file', () => {
    const annotations = buildPierreDiffCommentAnnotations(
      [note('one.ts'), note('two.ts')],
      'two.ts'
    )
    expect(annotations).toHaveLength(1)
    expect(annotations[0].metadata).toMatchObject({
      kind: 'comment',
      comment: { filePath: 'two.ts' }
    })
  })

  it('retains the range of an unsaved draft alongside existing notes', () => {
    expect(
      buildPierreDiffCommentAnnotations([note('one.ts')], 'one.ts', { lineNumber: 5, startLine: 3 })
    ).toHaveLength(2)
  })

  it('submits the same clamped anchor the draft card displays after the file shrinks', async () => {
    const [annotation] = buildPierreDiffCommentAnnotations(
      [],
      'one.ts',
      { lineNumber: 100, startLine: 90 },
      20
    )
    const onSubmitDraft = vi.fn(async () => true)
    const element = renderPierreDiffCommentAnnotation(annotation, {
      worktreeId: 'review',
      filePath: 'one.ts',
      activeGroupId: 'group',
      onDeleteComment: vi.fn(),
      clearDeliveredDiffComments: vi.fn(),
      onCancelDraft: vi.fn(),
      onSubmitDraft
    })
    if (
      !isValidElement<{
        lineNumber: number
        startLine?: number
        onSubmit: (body: string) => Promise<boolean>
      }>(element)
    ) {
      throw new Error('expected a draft card element')
    }
    expect(element.props.lineNumber).toBe(20)
    expect(element.props.startLine).toBeUndefined()
    await element.props.onSubmit('body')
    expect(onSubmitDraft).toHaveBeenCalledWith('body', { lineNumber: 20 })
  })
})
