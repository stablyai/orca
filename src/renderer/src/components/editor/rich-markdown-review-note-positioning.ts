import type { Editor } from '@tiptap/react'
import type { DiffComment } from '../../../../shared/types'
import {
  buildRichMarkdownCommentBlocks,
  getRichMarkdownCommentAnchorTop
} from './rich-markdown-review-annotations'
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
  const blocks = buildRichMarkdownCommentBlocks(editor)
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
        markdownSourceLineOffset
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
  for (const pos of positions) {
    const el = container.querySelector(`[data-rich-markdown-review-note-id="${pos.comment.id}"]`)
    if (el) {
      measuredHeights.set(pos.comment.id, el.getBoundingClientRect().height)
    }
  }
  return measuredHeights
}
