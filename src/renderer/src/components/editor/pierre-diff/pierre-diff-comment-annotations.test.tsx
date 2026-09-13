import { describe, expect, it, vi } from 'vitest'
import type { DecoratedDiffComment } from '../../diff-comments/decorated-diff-comment'
import { buildPierreDiffCommentAnnotations } from './pierre-diff-comment-annotations'

vi.mock('../../diff-comments/DiffCommentCard', () => ({ DiffCommentCard: () => null }))
vi.mock('../../diff-comments/DiffCommentPopover', () => ({ DiffCommentPopover: () => null }))
vi.mock('../NotesSendMenu', () => ({ NotesSendMenu: () => null }))

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
})
