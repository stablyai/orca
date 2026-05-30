import type { DiffComment } from '../../../../shared/types'

export type RichMarkdownReviewNotePosition = {
  comment: DiffComment
  top: number
}

export type RichMarkdownReviewRailState = {
  hasReviewNotes: boolean
  reviewRailOpen: boolean
  hasDraftNote: boolean
}

const REVIEW_NOTE_GAP_PX = 8
const REVIEW_NOTE_BASE_HEIGHT_PX = 58 // new Notion-style card base height (padding, border, gap, header)
const REVIEW_NOTE_BODY_LINE_HEIGHT_PX = 20 // new body line-height
const REVIEW_NOTE_QUOTE_HEIGHT_PX = 32 // new quote height (border, margins, text)

function getReviewNoteStartLine(comment: Pick<DiffComment, 'lineNumber' | 'startLine'>): number {
  return comment.startLine ?? comment.lineNumber
}

export function compareRichMarkdownReviewNotePositions(
  left: RichMarkdownReviewNotePosition,
  right: RichMarkdownReviewNotePosition
): number {
  const topCompare = left.top - right.top
  if (topCompare !== 0) {
    return topCompare
  }
  const startCompare = getReviewNoteStartLine(left.comment) - getReviewNoteStartLine(right.comment)
  if (startCompare !== 0) {
    return startCompare
  }
  if (left.comment.lineNumber !== right.comment.lineNumber) {
    return left.comment.lineNumber - right.comment.lineNumber
  }
  return left.comment.createdAt - right.comment.createdAt
}

export function stackRichMarkdownReviewNotePositions(
  positions: readonly RichMarkdownReviewNotePosition[],
  measuredHeights?: Map<string, number>
): RichMarkdownReviewNotePosition[] {
  let nextOpenTop = 0
  return [...positions].sort(compareRichMarkdownReviewNotePositions).map((position) => {
    const top = Math.max(position.top, nextOpenTop)
    const measured = measuredHeights?.get(position.comment.id)
    const estimatedHeight =
      REVIEW_NOTE_BASE_HEIGHT_PX +
      position.comment.body.split('\n').length * REVIEW_NOTE_BODY_LINE_HEIGHT_PX +
      (position.comment.selectedText ? REVIEW_NOTE_QUOTE_HEIGHT_PX : 0)
    const height = measured ?? estimatedHeight
    nextOpenTop = top + height + REVIEW_NOTE_GAP_PX
    return { ...position, top }
  })
}

export function shouldExpandRichMarkdownReviewRail({
  hasReviewNotes,
  reviewRailOpen,
  hasDraftNote
}: RichMarkdownReviewRailState): boolean {
  return hasDraftNote || (hasReviewNotes && reviewRailOpen)
}
