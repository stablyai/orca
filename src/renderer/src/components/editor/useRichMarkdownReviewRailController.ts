import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { Editor } from '@tiptap/react'
import {
  richMarkdownAnnotationHighlightPluginKey,
  type RichMarkdownAnnotationHighlightRange
} from './rich-markdown-annotation-highlight'
import { getRichMarkdownRangeBounds } from './rich-markdown-range-bounds'
import {
  clearRichMarkdownNotePositions,
  getRichMarkdownAnnotationHighlightRangesForComment
} from './rich-markdown-review-annotations'
import type { RichMarkdownReviewNotePosition } from './rich-markdown-review-note-layout'
import { measureRichMarkdownReviewNotePositions } from './rich-markdown-review-note-positioning'
import type { DiffComment } from '../../../../shared/types'

type UseRichMarkdownReviewRailControllerOptions = {
  canAnnotateRichMarkdown: boolean
  content: string
  editorRef: MutableRefObject<Editor | null>
  markdownComments: DiffComment[]
  markdownSourceLineOffset: number
  markdownSourceLineOffsetRef: MutableRefObject<number>
  scrollContainerRef: MutableRefObject<HTMLDivElement | null>
}

export function useRichMarkdownReviewRailController({
  canAnnotateRichMarkdown,
  content,
  editorRef,
  markdownComments,
  markdownSourceLineOffset,
  markdownSourceLineOffsetRef,
  scrollContainerRef
}: UseRichMarkdownReviewRailControllerOptions) {
  const [reviewRailOpen, setReviewRailOpen] = useState(false)
  const [activeReviewCommentId, setActiveReviewCommentId] = useState<string | null>(null)
  const [attentionReviewCommentId, setAttentionReviewCommentId] = useState<string | null>(null)
  const [notePositions, setNotePositions] = useState<RichMarkdownReviewNotePosition[]>([])
  const notePositionsRef = useRef<RichMarkdownReviewNotePosition[]>([])
  const attentionReviewCommentTimeoutRef = useRef<number | null>(null)
  const sourceAttentionTimeoutRef = useRef<number | null>(null)
  const notePositionsFrameRef = useRef<number | null>(null)
  const reviewRailVisible = markdownComments.length > 0 && reviewRailOpen

  notePositionsRef.current = notePositions

  const clearAttentionTimers = useCallback((): void => {
    clearWindowTimer(attentionReviewCommentTimeoutRef)
    clearWindowTimer(sourceAttentionTimeoutRef)
  }, [])

  const cancelNotePositionFrame = useCallback((): void => {
    cancelFrame(notePositionsFrameRef)
  }, [])

  const syncNotePositions = useCallback((): void => {
    const editor = editorRef.current
    const container = scrollContainerRef.current
    if (
      !reviewRailVisible ||
      !canAnnotateRichMarkdown ||
      !editor ||
      !container ||
      markdownComments.length === 0
    ) {
      clearRichMarkdownNotePositions(setNotePositions)
      return
    }
    setNotePositions(
      measureRichMarkdownReviewNotePositions({
        editor,
        container,
        markdownComments,
        markdownSourceLineOffset
      })
    )
  }, [
    canAnnotateRichMarkdown,
    editorRef,
    markdownComments,
    markdownSourceLineOffset,
    reviewRailVisible,
    scrollContainerRef
  ])

  const requestSyncNotePositions = useCallback((): void => {
    if (!reviewRailVisible) {
      clearRichMarkdownNotePositions(setNotePositions)
      return
    }
    if (notePositionsFrameRef.current !== null) {
      return
    }
    notePositionsFrameRef.current = window.requestAnimationFrame(() => {
      notePositionsFrameRef.current = null
      syncNotePositions()
    })
  }, [reviewRailVisible, syncNotePositions])

  const pulseRichMarkdownReviewNote = useCallback((commentId: string): void => {
    clearWindowTimer(attentionReviewCommentTimeoutRef)
    setAttentionReviewCommentId(null)
    window.requestAnimationFrame(() => {
      setAttentionReviewCommentId(commentId)
      attentionReviewCommentTimeoutRef.current = window.setTimeout(() => {
        attentionReviewCommentTimeoutRef.current = null
        setAttentionReviewCommentId(null)
      }, 900)
    })
  }, [])

  const scrollRichMarkdownReviewNoteCardIntoView = useCallback(
    (commentId: string): void => {
      setReviewRailOpen(true)
      setActiveReviewCommentId(commentId)
      pulseRichMarkdownReviewNote(commentId)
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() =>
          centerReviewNoteCard(scrollContainerRef.current, notePositionsRef.current, commentId)
        )
      })
    },
    [pulseRichMarkdownReviewNote, scrollContainerRef]
  )

  const pulseRichMarkdownSourceRange = useCallback(
    (range: RichMarkdownAnnotationHighlightRange): void => {
      const editor = editorRef.current
      if (!editor) {
        return
      }
      clearWindowTimer(sourceAttentionTimeoutRef)
      editor.view.dispatch(
        editor.state.tr.setMeta(richMarkdownAnnotationHighlightPluginKey, { activeRange: null })
      )
      window.requestAnimationFrame(() => {
        const latestEditor = editorRef.current
        if (!latestEditor) {
          return
        }
        latestEditor.view.dispatch(
          latestEditor.state.tr.setMeta(richMarkdownAnnotationHighlightPluginKey, {
            activeRange: range
          })
        )
        sourceAttentionTimeoutRef.current = window.setTimeout(() => {
          sourceAttentionTimeoutRef.current = null
          editorRef.current?.view.dispatch(
            editorRef.current.state.tr.setMeta(richMarkdownAnnotationHighlightPluginKey, {
              activeRange: null
            })
          )
        }, 900)
      })
    },
    [editorRef]
  )

  const scrollRichMarkdownReviewNoteSourceIntoView = useCallback(
    (comment: DiffComment): void => {
      const editor = editorRef.current
      const container = scrollContainerRef.current
      if (!editor || !container) {
        return
      }
      const ranges = getRichMarkdownAnnotationHighlightRangesForComment(
        editor,
        comment,
        markdownSourceLineOffsetRef.current
      )
      const bounds = getRichMarkdownRangeBounds(ranges)
      if (!bounds) {
        return
      }
      const maxPos = editor.state.doc.content.size
      const startCoords = editor.view.coordsAtPos(Math.max(1, Math.min(bounds.from, maxPos)))
      const endCoords = editor.view.coordsAtPos(Math.max(1, Math.min(bounds.to, maxPos)))
      const containerRect = container.getBoundingClientRect()
      const sourceTop = startCoords.top - containerRect.top + container.scrollTop
      const sourceBottom = endCoords.bottom - containerRect.top + container.scrollTop
      setActiveReviewCommentId(comment.id)
      container.scrollTo({
        top: Math.max(0, (sourceTop + sourceBottom) / 2 - container.clientHeight / 2),
        behavior: 'smooth'
      })
      pulseRichMarkdownSourceRange({ from: bounds.from, to: bounds.to })
    },
    [editorRef, markdownSourceLineOffsetRef, pulseRichMarkdownSourceRange, scrollContainerRef]
  )

  useEffect(() => requestSyncNotePositions(), [content, markdownComments, requestSyncNotePositions])

  useEffect(() => {
    if (!reviewRailVisible) {
      clearRichMarkdownNotePositions(setNotePositions)
      return
    }
    const container = scrollContainerRef.current
    if (!container) {
      return
    }
    const update = (): void => requestSyncNotePositions()
    container.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    requestSyncNotePositions()
    return () => {
      container.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [requestSyncNotePositions, reviewRailVisible, scrollContainerRef])

  return {
    activeReviewCommentId,
    attentionReviewCommentId,
    cancelNotePositionFrame,
    clearAttentionTimers,
    notePositions,
    reviewRailOpen,
    reviewRailVisible,
    scrollRichMarkdownReviewNoteCardIntoView,
    scrollRichMarkdownReviewNoteSourceIntoView,
    setReviewRailOpen,
    syncNotePositions
  }
}

function clearWindowTimer(ref: MutableRefObject<number | null>): void {
  if (ref.current !== null) {
    window.clearTimeout(ref.current)
    ref.current = null
  }
}

function cancelFrame(ref: MutableRefObject<number | null>): void {
  if (ref.current !== null) {
    window.cancelAnimationFrame(ref.current)
    ref.current = null
  }
}

function centerReviewNoteCard(
  container: HTMLDivElement | null,
  positions: RichMarkdownReviewNotePosition[],
  commentId: string
): void {
  const card = container?.querySelector<HTMLElement>(
    `[data-rich-markdown-review-note-id="${CSS.escape(commentId)}"]`
  )
  if (!container) {
    return
  }
  const position = positions.find((item) => item.comment.id === commentId)
  const cardHeight = card?.offsetHeight ?? 72
  const cardTop = position?.top ?? card?.offsetTop
  if (cardTop === undefined) {
    return
  }
  const targetTop = cardTop - Math.max(0, (container.clientHeight - cardHeight) / 2)
  container.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' })
}
