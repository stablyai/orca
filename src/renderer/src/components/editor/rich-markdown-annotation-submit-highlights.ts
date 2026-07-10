import type { Editor } from '@tiptap/react'
import type { DiffComment } from '../../../../shared/types'
import { richMarkdownAnnotationHighlightPluginKey } from './rich-markdown-annotation-highlight'
import {
  getRichMarkdownAnnotationHighlightRanges,
  type RichMarkdownAnnotationTarget
} from './rich-markdown-review-annotations'

export function updateRichMarkdownAnnotationHighlightsAfterSubmit({
  annotationPopover,
  comments,
  editor,
  markdownSourceLineOffset
}: {
  annotationPopover: RichMarkdownAnnotationTarget
  comments: DiffComment[]
  editor: Editor | null
  markdownSourceLineOffset: number
}): void {
  if (!editor) {
    return
  }
  const noteRanges = getRichMarkdownAnnotationHighlightRanges(
    editor,
    comments,
    markdownSourceLineOffset
  )
  const hasSubmittedRange = noteRanges.some(
    (range) => range.from <= annotationPopover.from && annotationPopover.to <= range.to
  )
  editor.view.dispatch(
    editor.state.tr.setMeta(richMarkdownAnnotationHighlightPluginKey, {
      activeRange: null,
      noteRanges: hasSubmittedRange
        ? noteRanges
        : [...noteRanges, { from: annotationPopover.from, to: annotationPopover.to }]
    })
  )
}
