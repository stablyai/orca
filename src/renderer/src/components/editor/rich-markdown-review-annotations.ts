import type { Dispatch, SetStateAction } from 'react'
import type { Editor } from '@tiptap/react'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import type { RichMarkdownAnnotationHighlightRange } from './rich-markdown-annotation-highlight'
import {
  getRichMarkdownLineRangeFromBlocks,
  getRichMarkdownRangeStart
} from './rich-markdown-range-bounds'
import type { RichMarkdownReviewNotePosition } from './rich-markdown-review-note-layout'
import { findRichMarkdownSelectedTextRanges } from './rich-markdown-review-text-ranges'
import { getRichMarkdownSelectionVisibleText } from './rich-markdown-visible-text-map'
import {
  getRichMarkdownCommentBlocks,
  type RichMarkdownCommentBlock
} from './rich-markdown-comment-blocks'
export {
  buildRichMarkdownCommentBlocks,
  type RichMarkdownCommentBlock
} from './rich-markdown-comment-blocks'
export { countRichMarkdownReviewMarkdownLines } from './rich-markdown-review-line-count'

const RICH_MARKDOWN_ANNOTATION_BUTTON_SIZE_PX = 24
const RICH_MARKDOWN_ANNOTATION_EDGE_PADDING_PX = 8
const RICH_MARKDOWN_ANNOTATION_SELECTION_GAP_PX = 8
const RICH_MARKDOWN_ANNOTATION_MIN_LEFT_PX = 56
const RICH_MARKDOWN_ANNOTATION_RIGHT_OFFSET_PX = 42
const RICH_MARKDOWN_ANNOTATION_POPOVER_WIDTH_PX = 420
const RICH_MARKDOWN_ANNOTATION_POPOVER_RIGHT_OFFSET_PX = 24
const RICH_MARKDOWN_ANNOTATION_POPOVER_MIN_HEIGHT_PX = 220

export type RichMarkdownComposerState = {
  lineNumber: number
  startLine?: number
}

export type RichMarkdownAnnotationTarget = RichMarkdownComposerState & {
  from: number
  to: number
  selectedText: string
  top: number
  left?: number
  buttonTop: number
  buttonLeft: number
}

export function clampRichMarkdownAnnotationTarget(
  editor: Editor,
  target: RichMarkdownAnnotationTarget
): RichMarkdownAnnotationTarget | null {
  const maxPos = Math.max(1, editor.state.doc.content.size)
  const from = Math.max(1, Math.min(target.from, maxPos))
  const to = Math.max(1, Math.min(target.to, maxPos))
  const clampedFrom = Math.min(from, to)
  const clampedTo = Math.max(from, to)
  if (clampedFrom === clampedTo) {
    return null
  }
  return { ...target, from: clampedFrom, to: clampedTo }
}

export function clearRichMarkdownNotePositions(
  setNotePositions: Dispatch<SetStateAction<RichMarkdownReviewNotePosition[]>>
): void {
  setNotePositions((current) => (current.length === 0 ? current : []))
}

export function getRichMarkdownAnnotationHighlightRanges(
  editor: Editor,
  comments: readonly DiffComment[],
  markdownSourceLineOffset: number
): RichMarkdownAnnotationHighlightRange[] {
  if (comments.length === 0) {
    return []
  }
  const blocks = getRichMarkdownCommentBlocks(editor)
  return comments.flatMap((comment) =>
    getRichMarkdownAnnotationHighlightRangesForComment(
      editor,
      comment,
      markdownSourceLineOffset,
      blocks
    )
  )
}

export function getRichMarkdownAnnotationHighlightRangesForComment(
  editor: Editor,
  comment: DiffComment,
  markdownSourceLineOffset: number,
  prebuiltBlocks?: readonly RichMarkdownCommentBlock[]
): RichMarkdownAnnotationHighlightRange[] {
  const blocks = prebuiltBlocks ?? getRichMarkdownCommentBlocks(editor)
  const selectedText = comment.selectedText?.trim()
  if (!selectedText) {
    return []
  }
  const bodyLineNumber = Math.max(1, comment.lineNumber - markdownSourceLineOffset)
  const block = blocks.find(
    (candidate) => candidate.startLine <= bodyLineNumber && bodyLineNumber <= candidate.endLine
  )
  if (block) {
    const blockRanges = findRichMarkdownSelectedTextRanges({
      editor,
      selectedText,
      from: block.from,
      to: block.to
    })
    if (blockRanges.length > 0) {
      return blockRanges
    }
  }
  return findRichMarkdownSelectedTextRanges({ editor, selectedText })
}

export function getRichMarkdownCommentAtPos(
  editor: Editor,
  comments: readonly DiffComment[],
  markdownSourceLineOffset: number,
  pos: number
): DiffComment | null {
  if (comments.length === 0) {
    return null
  }
  const blocks = getRichMarkdownCommentBlocks(editor)
  return (
    comments.find((comment) =>
      getRichMarkdownAnnotationHighlightRangesForComment(
        editor,
        comment,
        markdownSourceLineOffset,
        blocks
      ).some((range) => range.from <= pos && pos <= range.to)
    ) ?? null
  )
}

export function getRichMarkdownCommentAnchorTop(
  editor: Editor,
  comment: DiffComment,
  block: RichMarkdownCommentBlock,
  containerRect: DOMRect,
  containerScrollTop: number,
  markdownSourceLineOffset: number,
  prebuiltBlocks?: readonly RichMarkdownCommentBlock[]
): number | null {
  try {
    const ranges = getRichMarkdownAnnotationHighlightRangesForComment(
      editor,
      comment,
      markdownSourceLineOffset,
      prebuiltBlocks
    )
    // Why: range notes should sort by the start of the selected text. Anchoring
    // to the end puts overlapping ranges with the same final line in creation
    // order, so a 43-45 card can render above a 41-45 card.
    const anchorPos = getRichMarkdownRangeStart(ranges) ?? block.from
    const coords = editor.view.coordsAtPos(
      Math.max(1, Math.min(anchorPos, editor.state.doc.content.size))
    )
    return coords.top - containerRect.top + containerScrollTop
  } catch {
    return null
  }
}

function getRichMarkdownSelectionRange(editor: Editor): RichMarkdownComposerState {
  const blocks = getRichMarkdownCommentBlocks(editor)
  const { from, to, empty } = editor.state.selection
  const selectedBlocks = empty
    ? blocks.filter((block) => block.from <= from && from <= block.to)
    : blocks.filter((block) => from <= block.to && to >= block.from)
  const targetBlocks = selectedBlocks.length > 0 ? selectedBlocks : [blocks[0]!]
  return getRichMarkdownLineRangeFromBlocks(targetBlocks) ?? { lineNumber: 1 }
}

export function hasRichMarkdownCommentForRange(
  comments: readonly DiffComment[],
  target: Pick<RichMarkdownAnnotationTarget, 'lineNumber' | 'selectedText' | 'startLine'>,
  markdownSourceLineOffset: number
): boolean {
  const startLine = (target.startLine ?? target.lineNumber) + markdownSourceLineOffset
  const endLine = target.lineNumber + markdownSourceLineOffset
  const selectedText = target.selectedText.trim()
  return comments.some((comment) => {
    const commentStartLine = comment.startLine ?? comment.lineNumber
    return (
      commentStartLine === startLine &&
      comment.lineNumber === endLine &&
      (comment.selectedText?.trim() ?? '') === selectedText
    )
  })
}

function getCurrentRichMarkdownSelectionRect(root: HTMLElement): DOMRect | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null
  }
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) {
    return null
  }
  const rect = range.getBoundingClientRect()
  if (rect.width > 0 || rect.height > 0) {
    return rect
  }
  return Array.from(range.getClientRects()).find((candidate) => candidate.width > 0) ?? null
}

export function getRichMarkdownAnnotationButtonTop(
  selectionBottomInRoot: number,
  rootHeight: number
): number {
  const preferredTop = selectionBottomInRoot + RICH_MARKDOWN_ANNOTATION_SELECTION_GAP_PX
  const maxTop = Math.max(
    RICH_MARKDOWN_ANNOTATION_EDGE_PADDING_PX,
    rootHeight - RICH_MARKDOWN_ANNOTATION_BUTTON_SIZE_PX - RICH_MARKDOWN_ANNOTATION_EDGE_PADDING_PX
  )
  return Math.max(RICH_MARKDOWN_ANNOTATION_EDGE_PADDING_PX, Math.min(preferredTop, maxTop))
}

export function getRichMarkdownAnnotationButtonLeft(rootWidth: number): number {
  const preferredLeft = Math.max(
    RICH_MARKDOWN_ANNOTATION_MIN_LEFT_PX,
    rootWidth - RICH_MARKDOWN_ANNOTATION_RIGHT_OFFSET_PX
  )
  const maxLeft = Math.max(
    RICH_MARKDOWN_ANNOTATION_EDGE_PADDING_PX,
    rootWidth - RICH_MARKDOWN_ANNOTATION_BUTTON_SIZE_PX - RICH_MARKDOWN_ANNOTATION_EDGE_PADDING_PX
  )
  return Math.min(preferredLeft, maxLeft)
}

export function getRichMarkdownAnnotationTarget(
  editor: Editor,
  root: HTMLElement
): RichMarkdownAnnotationTarget | null {
  if (editor.state.selection.empty) {
    return null
  }
  const rect = getCurrentRichMarkdownSelectionRect(root)
  if (!rect) {
    return null
  }
  const selectedText = getRichMarkdownSelectionVisibleText(editor.state)
  if (!selectedText) {
    return null
  }
  const rootRect = root.getBoundingClientRect()
  // Why: long selections can extend below the visible editor shell; keep the
  // add-note affordance reachable instead of anchoring to hidden selection area.
  const buttonTop = getRichMarkdownAnnotationButtonTop(rect.bottom - rootRect.top, rootRect.height)
  const left = Math.max(
    RICH_MARKDOWN_ANNOTATION_MIN_LEFT_PX,
    rootRect.width -
      RICH_MARKDOWN_ANNOTATION_POPOVER_WIDTH_PX -
      RICH_MARKDOWN_ANNOTATION_POPOVER_RIGHT_OFFSET_PX
  )
  const popoverTop = Math.max(
    RICH_MARKDOWN_ANNOTATION_EDGE_PADDING_PX,
    Math.min(
      buttonTop + RICH_MARKDOWN_ANNOTATION_BUTTON_SIZE_PX + 6,
      rootRect.height - RICH_MARKDOWN_ANNOTATION_POPOVER_MIN_HEIGHT_PX
    )
  )
  return {
    ...getRichMarkdownSelectionRange(editor),
    from: editor.state.selection.from,
    to: editor.state.selection.to,
    selectedText,
    top: popoverTop,
    left,
    buttonTop,
    buttonLeft: getRichMarkdownAnnotationButtonLeft(rootRect.width)
  }
}
