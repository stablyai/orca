// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { parseDiffFromFile } from '@pierre/diffs'
import { renderDiffChildren } from '../../../../../../node_modules/@pierre/diffs/dist/react/utils/renderDiffChildren.js'
import {
  buildPierreDiffCommentAnnotations,
  renderPierreDiffCommentAnnotation,
  type PierreDiffAnnotationData
} from './pierre-diff-comment-annotations'
import type { DecoratedDiffComment } from '../../diff-comments/decorated-diff-comment'

vi.mock('@/components/editor/review-note-delivery/NotesSendMenu', () => ({
  NotesSendMenu: () => null
}))
afterEach(cleanup)

it('saves an edited note to its own id after a preceding sibling is deleted', async () => {
  const notes: DecoratedDiffComment[] = ['A', 'B', 'C'].map((id) => ({
    id,
    filePath: 'file.ts',
    worktreeId: 'wt',
    lineNumber: 1,
    body: `note ${id}`,
    createdAt: 1,
    side: 'modified'
  }))
  const save = vi.fn(async () => true)
  const fileDiff = parseDiffFromFile(null, { name: 'file.ts', contents: 'line\n' })
  const children = (comments: DecoratedDiffComment[]) =>
    renderDiffChildren<PierreDiffAnnotationData, undefined, unknown>({
      fileDiff,
      lineAnnotations: buildPierreDiffCommentAnnotations(comments, 'file.ts'),
      renderCustomHeader: undefined,
      renderHeaderPrefix: undefined,
      renderHeaderMetadata: undefined,
      renderGutterUtility: undefined,
      getHoveredLine: () => undefined,
      renderAnnotation: (annotation) =>
        renderPierreDiffCommentAnnotation(annotation, {
          worktreeId: 'wt',
          filePath: 'file.ts',
          activeGroupId: 'g',
          clearDeliveredDiffComments: async () => true,
          onDeleteComment: () => {},
          onUpdateComment: save
        })
    })
  const view = render(<>{children(notes)}</>)
  const noteB = view.container.querySelector<HTMLElement>('[data-diff-comment-id="B"]')!
  fireEvent.click(within(noteB).getByRole('button', { name: 'Edit note' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'edited B' } })
  view.rerender(<>{children(notes.slice(1))}</>)
  const textarea = screen.getByRole('textbox')
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error('Expected note editor')
  }
  expect(textarea.value).toBe('edited B')
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(save).toHaveBeenCalledWith('B', 'edited B')
  expect(screen.getByText('note C')).toBeTruthy()
})
