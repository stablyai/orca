import type { Editor } from '@tiptap/react'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import { getRichMarkdownCommentAnchorTop } from './rich-markdown-review-annotations'
import { getRichMarkdownCommentBlocks } from './rich-markdown-comment-blocks'
import {
  stackRichMarkdownReviewNotePositions,
  type RichMarkdownReviewNotePosition
} from './rich-markdown-review-note-layout'

type MeasureRichMarkdownReviewNotePositionsOptions = {
  container: HTMLDivElement
  editor: Editor
  markdownComments: DiffComment[]
  markdownSourceLineOffset: number
}

export function measureRichMarkdownReviewNotePositions({
  container,
  editor,
  markdownComments,
  markdownSourceLineOffset
}: MeasureRichMarkdownReviewNotePositionsOptions): RichMarkdownReviewNotePosition[] {
  const containerRect = container.getBoundingClientRect()
  const blocks = getRichMarkdownCommentBlocks(editor)
  const nextPositions = markdownComments
    .map((comment): RichMarkdownReviewNotePosition | null => {
      const bodyLineNumber = Math.max(1, comment.lineNumber - markdownSourceLineOffset)
      const block = blocks.find(
        (candidate) => candidate.startLine <= bodyLineNumber && bodyLineNumber <= candidate.endLine
      )
      if (!block) {
        return null
      }
      const top = getRichMarkdownCommentAnchorTop(
        editor,
        comment,
        block,
        containerRect,
        container.scrollTop,
        markdownSourceLineOffset,
        blocks
      )
      return top === null ? null : { comment, top }
    })
    .filter((position): position is RichMarkdownReviewNotePosition => position !== null)
  return stackRichMarkdownReviewNotePositions(
    nextPositions,
    measureReviewNoteHeights(container, nextPositions)
  )
}

function measureReviewNoteHeights(
  container: HTMLDivElement,
  positions: RichMarkdownReviewNotePosition[]
): Map<string, number> {
  const measuredHeights = new Map<string, number>()
  if (positions.length === 0) {
    return measuredHeights
  }
  const commentIds = new Set(positions.map((position) => position.comment.id))
  for (const el of container.querySelectorAll('[data-rich-markdown-review-note-id]')) {
    const id = el.getAttribute('data-rich-markdown-review-note-id')
    if (id !== null && commentIds.has(id) && !measuredHeights.has(id)) {
      measuredHeights.set(id, el.getBoundingClientRect().height)
    }
  }
  return measuredHeights
}
