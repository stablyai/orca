import { useCallback } from 'react'
import { copyMarkdownReviewNotesForAgent } from '@/lib/markdown-review-note-copy'
import type { MarkdownReviewNote } from '@/lib/markdown-review-notes'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import type { MarkdownPreviewBlockRange } from './markdown-preview-types'
import { requestMarkdownPreviewEditorRevealFrame } from './markdown-preview-editor-reveal'
import type { MarkdownPreviewFoundation } from './use-markdown-preview-foundation'
import type { MarkdownPreviewViewport } from './use-markdown-preview-viewport'

function isMarkdownAnnotationNavigationClick(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  return !target.closest(
    'a,button,input,textarea,select,summary,[contenteditable="true"],.markdown-annotation-controls'
  )
}

export function useMarkdownPreviewReviewActions({
  foundation,
  viewport
}: {
  foundation: MarkdownPreviewFoundation
  viewport: MarkdownPreviewViewport
}) {
  const {
    rootRef,
    renderedContent,
    markdownReviewNotes,
    reviewNotesCopyMountedRef,
    setReviewNotesCopied,
    reviewNotesCopiedResetTimerRef,
    setCopiedReviewNoteId,
    copiedReviewNoteResetTimerRef,
    attentionReviewCommentTimeoutRef,
    pendingReviewActionFrameIdsRef,
    pendingReviewActionTimeoutIdsRef,
    reviewActionFrameGenerationRef,
    setAttentionReviewCommentId,
    setActiveReviewCommentId,
    markdownComments,
    activeReviewCommentId
  } = foundation
  const { clearReviewNotesCopiedResetTimer, clearCopiedReviewNoteResetTimer, scrollToSourceLine } =
    viewport

  const handleCopyMarkdownReviewNotes = useCallback(async (): Promise<void> => {
    if (markdownReviewNotes.length === 0) {
      return
    }
    try {
      const copied = await copyMarkdownReviewNotesForAgent({
        notes: markdownReviewNotes,
        content: renderedContent,
        writeClipboardText: window.api.ui.writeClipboardText
      })
      if (!copied || !reviewNotesCopyMountedRef.current) {
        return
      }
      clearReviewNotesCopiedResetTimer()
      setReviewNotesCopied(true)
      reviewNotesCopiedResetTimerRef.current = window.setTimeout(() => {
        reviewNotesCopiedResetTimerRef.current = null
        setReviewNotesCopied(false)
      }, 1600)
    } catch {
      // Best-effort clipboard action; failures usually mean the window is not focused.
    }
  }, [
    clearReviewNotesCopiedResetTimer,
    markdownReviewNotes,
    renderedContent,
    reviewNotesCopyMountedRef,
    reviewNotesCopiedResetTimerRef,
    setReviewNotesCopied
  ])

  const handleCopyMarkdownReviewNote = useCallback(
    async (note: MarkdownReviewNote): Promise<void> => {
      try {
        const copied = await copyMarkdownReviewNotesForAgent({
          notes: [note],
          content: renderedContent,
          writeClipboardText: window.api.ui.writeClipboardText
        })
        if (!copied || !reviewNotesCopyMountedRef.current) {
          return
        }
        clearCopiedReviewNoteResetTimer()
        setCopiedReviewNoteId(note.id)
        copiedReviewNoteResetTimerRef.current = window.setTimeout(() => {
          copiedReviewNoteResetTimerRef.current = null
          setCopiedReviewNoteId(null)
        }, 1600)
      } catch {
        // Best-effort clipboard action; failures usually mean the window is not focused.
      }
    },
    [
      clearCopiedReviewNoteResetTimer,
      copiedReviewNoteResetTimerRef,
      renderedContent,
      reviewNotesCopyMountedRef,
      setCopiedReviewNoteId
    ]
  )

  const pulseRenderedMarkdownReviewNote = useCallback(
    (commentId: string, isCurrent: () => boolean): void => {
      if (attentionReviewCommentTimeoutRef.current !== null) {
        const timeout = attentionReviewCommentTimeoutRef.current
        window.clearTimeout(timeout)
        pendingReviewActionTimeoutIdsRef.current = pendingReviewActionTimeoutIdsRef.current.filter(
          (pending) => pending !== timeout
        )
      }
      setAttentionReviewCommentId(null)
      if (!isCurrent()) {
        return
      }
      requestMarkdownPreviewEditorRevealFrame(pendingReviewActionFrameIdsRef, () => {
        if (!isCurrent()) {
          return
        }
        setAttentionReviewCommentId(commentId)
        if (!isCurrent()) {
          return
        }
        let completed = false
        let timeout: number | undefined
        timeout = window.setTimeout(() => {
          completed = true
          if (!isCurrent()) {
            return
          }
          pendingReviewActionTimeoutIdsRef.current =
            pendingReviewActionTimeoutIdsRef.current.filter((pending) => pending !== timeout)
          setAttentionReviewCommentId(null)
          if (isCurrent()) {
            attentionReviewCommentTimeoutRef.current = null
          }
        }, 900)
        if (!completed) {
          attentionReviewCommentTimeoutRef.current = timeout
          pendingReviewActionTimeoutIdsRef.current.push(timeout)
        }
      })
    },
    [
      attentionReviewCommentTimeoutRef,
      pendingReviewActionFrameIdsRef,
      pendingReviewActionTimeoutIdsRef,
      setAttentionReviewCommentId
    ]
  )

  const findRenderedMarkdownReviewNoteCard = useCallback(
    (commentId: string): HTMLElement | null => {
      const root = rootRef.current
      if (!root) {
        return null
      }
      return (
        Array.from(root.querySelectorAll<HTMLElement>('[data-markdown-review-note-id]')).find(
          (candidate) => candidate.dataset.markdownReviewNoteId === commentId
        ) ?? null
      )
    },
    [rootRef]
  )

  const scrollRenderedMarkdownReviewNoteIntoView = useCallback(
    (comment: DiffComment): void => {
      const generation = reviewActionFrameGenerationRef.current
      const isCurrent = (): boolean =>
        reviewNotesCopyMountedRef.current && reviewActionFrameGenerationRef.current === generation
      if (!isCurrent()) {
        return
      }
      setActiveReviewCommentId(comment.id)
      if (!isCurrent()) {
        return
      }
      pulseRenderedMarkdownReviewNote(comment.id, isCurrent)
      if (!isCurrent()) {
        return
      }
      requestMarkdownPreviewEditorRevealFrame(pendingReviewActionFrameIdsRef, () => {
        if (!isCurrent()) {
          return
        }
        findRenderedMarkdownReviewNoteCard(comment.id)?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
          inline: 'nearest'
        })
      })
    },
    [
      findRenderedMarkdownReviewNoteCard,
      pendingReviewActionFrameIdsRef,
      pulseRenderedMarkdownReviewNote,
      reviewActionFrameGenerationRef,
      reviewNotesCopyMountedRef,
      setActiveReviewCommentId
    ]
  )

  const scrollToReviewNote = useCallback(
    (comment: DiffComment): void => {
      setActiveReviewCommentId(comment.id)
      if (scrollToSourceLine(comment.lineNumber)) {
        return
      }
      const root = rootRef.current
      if (!root) {
        return
      }
      const blocks = root.querySelectorAll<HTMLElement>('[data-source-line][data-source-end-line]')
      let target: HTMLElement | null = null
      for (const block of blocks) {
        const startLine = Number(block.dataset.sourceLine)
        const endLine = Number(block.dataset.sourceEndLine)
        if (startLine <= comment.lineNumber && comment.lineNumber <= endLine) {
          target = block
          break
        }
      }
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    },
    [rootRef, scrollToSourceLine, setActiveReviewCommentId]
  )

  const getMarkdownCommentsForRange = useCallback(
    (range: MarkdownPreviewBlockRange): DiffComment[] =>
      markdownComments.filter(
        (comment) => range.startLine <= comment.lineNumber && comment.lineNumber <= range.endLine
      ),
    [markdownComments]
  )

  const handleAnnotatedMarkdownBlockClick = useCallback(
    (range: MarkdownPreviewBlockRange, event: React.MouseEvent<HTMLElement>): void => {
      if (!isMarkdownAnnotationNavigationClick(event.target)) {
        return
      }
      const commentsForBlock = getMarkdownCommentsForRange(range)
      const comment =
        commentsForBlock.find((candidate) => candidate.id !== activeReviewCommentId) ??
        commentsForBlock[0]
      if (!comment) {
        return
      }
      scrollRenderedMarkdownReviewNoteIntoView(comment)
    },
    [activeReviewCommentId, getMarkdownCommentsForRange, scrollRenderedMarkdownReviewNoteIntoView]
  )

  return {
    handleCopyMarkdownReviewNotes,
    handleCopyMarkdownReviewNote,
    scrollToReviewNote,
    getMarkdownCommentsForRange,
    handleAnnotatedMarkdownBlockClick
  }
}

export type MarkdownPreviewReviewActions = ReturnType<typeof useMarkdownPreviewReviewActions>
