import type { Editor } from '@tiptap/react'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import {
  buildRichMarkdownCommentBlocks,
  getRichMarkdownCommentAnchorTop,
  type RichMarkdownCommentBlock
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

// Why: separator lines between blocks belong to no block and an edit can leave a note past
// the last one; the badge and the source view still show such a note, so anchor it to the
// nearest preceding block instead of dropping the card. Blocks are ascending, so the last
// block starting at or before the line is also the containing one when there is one.
function findReviewNoteBlock(
  blocks: RichMarkdownCommentBlock[],
  bodyLineNumber: number
): RichMarkdownCommentBlock | null {
  return blocks.findLast((candidate) => candidate.startLine <= bodyLineNumber) ?? null
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
      const block = findReviewNoteBlock(blocks, bodyLineNumber)
      if (!block) {
        return null
      }
      // Why: the anchor lookup rebuilds the block table per note unless handed this one.
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
  for (const pos of positions) {
    const el = container.querySelector(`[data-rich-markdown-review-note-id="${pos.comment.id}"]`)
    if (el) {
      measuredHeights.set(pos.comment.id, el.getBoundingClientRect().height)
    }
  }
  return measuredHeights
}
