import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { Editor } from '@tiptap/react'
import type { AppState } from '@/store'
import { richMarkdownAnnotationHighlightPluginKey } from './rich-markdown-annotation-highlight'
import { updateRichMarkdownAnnotationHighlightsAfterSubmit } from './rich-markdown-annotation-submit-highlights'
import {
  clampRichMarkdownAnnotationTarget,
  getRichMarkdownAnnotationTarget,
  hasRichMarkdownCommentForRange,
  type RichMarkdownAnnotationTarget
} from './rich-markdown-review-annotations'
import { shouldExpandRichMarkdownReviewRail } from './rich-markdown-review-note-layout'
import { flushPendingProseMirrorSelection } from './rich-markdown-selection-flush'
import { useRichMarkdownReviewData } from './useRichMarkdownReviewData'
import { useRichMarkdownReviewCopyFeedback } from './useRichMarkdownReviewCopyFeedback'
import { useRichMarkdownReviewRailController } from './useRichMarkdownReviewRailController'
import type { DiffComment } from '../../../../shared/diff-comment-types'

type UseRichMarkdownReviewControllerOptions = {
  addDiffComment: AppState['addDiffComment']
  allDiffComments: DiffComment[] | undefined
  content: string
  editorRef: MutableRefObject<Editor | null>
  filePath: string
  markdownAnnotationFilePath?: string
  markdownAnnotationsEnabled: boolean
  markdownReviewContent: string
  markdownSourceLineOffset: number
  rootRef: MutableRefObject<HTMLDivElement | null>
  scrollContainerRef: MutableRefObject<HTMLDivElement | null>
  worktreeId: string
  worktreeRoot: string | null
}

export function useRichMarkdownReviewController({
  addDiffComment,
  allDiffComments,
  content,
  editorRef,
  filePath,
  markdownAnnotationFilePath,
  markdownAnnotationsEnabled,
  markdownReviewContent,
  markdownSourceLineOffset,
  rootRef,
  scrollContainerRef,
  worktreeId,
  worktreeRoot
}: UseRichMarkdownReviewControllerOptions) {
  const [annotationTarget, setAnnotationTarget] = useState<RichMarkdownAnnotationTarget | null>(
    null
  )
  const [annotationPopover, setAnnotationPopover] = useState<RichMarkdownAnnotationTarget | null>(
    null
  )
  const annotationPopoverRef = useRef<RichMarkdownAnnotationTarget | null>(null)
  const canAnnotateRichMarkdownRef = useRef(false)
  const markdownCommentsRef = useRef<DiffComment[]>([])
  const markdownSourceLineOffsetRef = useRef(markdownSourceLineOffset)
  const annotationTargetFrameRef = useRef<number | null>(null)
  const {
    canAnnotateRichMarkdown,
    markdownComments,
    markdownReviewNotes,
    sourceRelativePath,
    unsentMarkdownReviewScope
  } = useRichMarkdownReviewData({
    allDiffComments,
    filePath,
    markdownAnnotationFilePath,
    markdownAnnotationsEnabled,
    markdownReviewContent,
    worktreeRoot
  })

  annotationPopoverRef.current = annotationPopover
  canAnnotateRichMarkdownRef.current = canAnnotateRichMarkdown
  markdownCommentsRef.current = markdownComments
  markdownSourceLineOffsetRef.current = markdownSourceLineOffset

  const copyFeedback = useRichMarkdownReviewCopyFeedback({
    markdownReviewContent,
    markdownReviewNotes,
    rootRef
  })
  const { clearReviewCopyTimers } = copyFeedback
  const rail = useRichMarkdownReviewRailController({
    canAnnotateRichMarkdown,
    content,
    editorRef,
    markdownComments,
    markdownSourceLineOffset,
    markdownSourceLineOffsetRef,
    scrollContainerRef
  })
  const { cancelNotePositionFrame, clearAttentionTimers, setReviewRailOpen } = rail
  const reviewRailExpanded = shouldExpandRichMarkdownReviewRail({
    hasReviewNotes: markdownComments.length > 0,
    reviewRailOpen: rail.reviewRailOpen,
    hasDraftNote: annotationPopover !== null
  })

  const clearAllAnnotationHighlights = useCallback((): void => {
    const editor = editorRef.current
    if (!editor) {
      return
    }
    editor.view.dispatch(
      editor.state.tr.setMeta(richMarkdownAnnotationHighlightPluginKey, {
        activeRange: null,
        noteRanges: []
      })
    )
  }, [editorRef])

  const clearAnnotationHighlight = useCallback((): void => {
    const editor = editorRef.current
    editor?.view.dispatch(editor.state.tr.setMeta(richMarkdownAnnotationHighlightPluginKey, null))
  }, [editorRef])

  const clearAnnotationTarget = useCallback((): void => setAnnotationTarget(null), [])

  const clearTransientReviewState = useCallback((): void => {
    clearAttentionTimers()
    clearReviewCopyTimers()
    clearAllAnnotationHighlights()
    cancelFrame(annotationTargetFrameRef)
    cancelNotePositionFrame()
  }, [
    cancelNotePositionFrame,
    clearAllAnnotationHighlights,
    clearAttentionTimers,
    clearReviewCopyTimers
  ])

  const syncAnnotationTarget = useCallback(
    (editor: Editor): void => {
      cancelFrame(annotationTargetFrameRef)
      annotationTargetFrameRef.current = window.requestAnimationFrame(() => {
        annotationTargetFrameRef.current = null
        const root = rootRef.current
        if (!root || annotationPopoverRef.current || !canAnnotateRichMarkdownRef.current) {
          setAnnotationTarget(null)
          return
        }
        const target = getRichMarkdownAnnotationTarget(editor, root)
        const hasExistingComment =
          target &&
          hasRichMarkdownCommentForRange(
            markdownCommentsRef.current,
            target,
            markdownSourceLineOffsetRef.current
          )
        setAnnotationTarget(hasExistingComment ? null : target)
      })
    },
    [rootRef]
  )

  const submitAnnotation = useCallback(
    async (body: string): Promise<void> => {
      if (!annotationPopover || sourceRelativePath === null) {
        return
      }
      const submittedEditor = editorRef.current
      const result = await addDiffComment({
        worktreeId,
        filePath: sourceRelativePath,
        source: 'markdown',
        startLine:
          annotationPopover.startLine === undefined
            ? undefined
            : annotationPopover.startLine + markdownSourceLineOffset,
        lineNumber: annotationPopover.lineNumber + markdownSourceLineOffset,
        selectedText: annotationPopover.selectedText,
        body,
        side: 'modified'
      })
      if (!result) {
        console.error('Failed to add markdown comment — draft preserved')
        return
      }
      if (
        !submittedEditor ||
        submittedEditor.isDestroyed ||
        annotationPopoverRef.current !== annotationPopover
      ) {
        return
      }
      const currentComments = markdownCommentsRef.current
      updateRichMarkdownAnnotationHighlightsAfterSubmit({
        annotationPopover,
        comments: currentComments.some((comment) => comment.id === result.id)
          ? currentComments
          : [...currentComments, result],
        editor: submittedEditor,
        markdownSourceLineOffset
      })
      setAnnotationPopover(null)
      clearAnnotationHighlight()
      window.getSelection()?.removeAllRanges()
    },
    [
      addDiffComment,
      annotationPopover,
      clearAnnotationHighlight,
      editorRef,
      markdownSourceLineOffset,
      sourceRelativePath,
      worktreeId
    ]
  )

  // Report opened/retained composers so keyboard callers consume only handled chords.
  const openAnnotationPopover = useCallback(
    (requireLiveSelection = false): boolean => {
      if (!canAnnotateRichMarkdown) {
        return false
      }
      // Consume repeated open requests without remounting a composer and losing its draft.
      if (annotationPopoverRef.current) {
        return true
      }
      const editor = editorRef.current
      const root = rootRef.current
      // Flush native mouse selection before choosing the target; a chord can precede ProseMirror’s selection sync.
      if (editor) {
        flushPendingProseMirrorSelection(editor)
      }
      // Keyboard actions need live targets; mouse buttons may use the target their render exposed.
      const liveTarget = editor && root ? getRichMarkdownAnnotationTarget(editor, root) : null
      const baseTarget = liveTarget ?? (requireLiveSelection ? null : annotationTarget)
      if (!baseTarget) {
        return false
      }
      const target = editor ? clampRichMarkdownAnnotationTarget(editor, baseTarget) : baseTarget
      if (
        !target ||
        hasRichMarkdownCommentForRange(markdownComments, target, markdownSourceLineOffset)
      ) {
        setAnnotationTarget(null)
        return false
      }
      editor?.view.dispatch(
        editor.state.tr.setMeta(richMarkdownAnnotationHighlightPluginKey, {
          activeRange: { from: target.from, to: target.to }
        })
      )
      // Claim the draft before setState so same-tick chords/repeats cannot remount it and discard typing.
      annotationPopoverRef.current = target
      // Why: opening a draft should reserve the notes rail immediately; saved notes stay visible.
      setReviewRailOpen(true)
      setAnnotationPopover(target)
      setAnnotationTarget(null)
      return true
    },
    [
      annotationTarget,
      canAnnotateRichMarkdown,
      editorRef,
      markdownComments,
      markdownSourceLineOffset,
      rootRef,
      setReviewRailOpen
    ]
  )

  useEffect(() => {
    if (canAnnotateRichMarkdown) {
      return
    }
    // Remove transient highlights/popovers immediately when annotations become unavailable.
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setAnnotationTarget(null)
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setAnnotationPopover(null)
    clearAllAnnotationHighlights()
  }, [canAnnotateRichMarkdown, clearAllAnnotationHighlights])

  return {
    ...copyFeedback,
    ...rail,
    annotationPopover,
    annotationTarget,
    canAnnotateRichMarkdown,
    clearAnnotationHighlight,
    clearAnnotationTarget,
    clearAllAnnotationHighlights,
    clearTransientReviewState,
    markdownComments,
    markdownCommentsRef,
    markdownSourceLineOffsetRef,
    openAnnotationPopover,
    reviewRailExpanded,
    setAnnotationPopover,
    submitAnnotation,
    syncAnnotationTarget,
    unsentMarkdownReviewScope
  }
}

function cancelFrame(ref: MutableRefObject<number | null>): void {
  if (ref.current !== null) {
    window.cancelAnimationFrame(ref.current)
    ref.current = null
  }
}
