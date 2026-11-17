import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { PostRenderPhase, SelectedLineRange } from '@pierre/diffs'
import type { Editor } from '@pierre/diffs/edit'
import { getShadowRootSelection } from '@/lib/shadow-root-selection'
import { installEditorAddReviewNoteShortcut } from '@/components/editor/commands/editor-shortcuts'
import { canCommentOnPierreRange } from './pierre-diff-comment-range'
import { getPierreSelectionRange, selectionSide } from './pierre-diff-selection'
import type { PierreDiffInstance } from './PierreDiffSurface'

export function usePierreDiffNoteSelection({
  containerRef,
  editorRef,
  onAddComment,
  pendingComment,
  commentableLines
}: {
  containerRef: React.RefObject<HTMLElement | null>
  editorRef: React.RefObject<Pick<Editor, 'getViewState'> | null>
  onAddComment?: (range: { lineNumber: number; startLine?: number }) => void
  pendingComment?: { lineNumber: number; startLine?: number } | null
  commentableLines: ReadonlySet<number> | null
}) {
  const view = useRef<{ host: HTMLElement; instance: PierreDiffInstance } | null>(null)
  const pointer = useRef<{ id: number; utility: boolean } | null>(null)
  const hadDraft = useRef(false)
  const addComment = useCallback(
    (range: SelectedLineRange | null) => {
      if (!range || !onAddComment || !canCommentOnPierreRange(range, commentableLines)) {
        return false
      }
      onAddComment({
        lineNumber: Math.max(range.start, range.end),
        startLine: range.start === range.end ? undefined : Math.min(range.start, range.end)
      })
      return true
    },
    [onAddComment, commentableLines]
  )
  useLayoutEffect(() => {
    if (!pendingComment && !hadDraft.current) {
      return
    }
    hadDraft.current = Boolean(pendingComment)
    view.current?.instance.setSelectedLines(
      pendingComment
        ? {
            start: pendingComment.startLine ?? pendingComment.lineNumber,
            end: pendingComment.lineNumber,
            side: 'additions'
          }
        : null
    )
  }, [pendingComment])
  useEffect(() => {
    const container = containerRef.current
    if (!container || !onAddComment) {
      return
    }
    const stopShortcut = installEditorAddReviewNoteShortcut(container, () => {
      if (pendingComment) {
        return true
      }
      const selection = getShadowRootSelection(view.current?.host.shadowRoot)
      const range = getPierreSelectionRange(selection ?? null)
      if (selection?.anchorNode && selectionSide(selection.anchorNode) === 'deletions') {
        return false
      }
      const selected = editorRef.current?.getViewState().selections?.at(-1)
      return selected
        ? addComment({
            start: selected.start.line + 1,
            end: selected.end.line + 1,
            side: 'additions'
          })
        : Boolean(
            range &&
            addComment({
              start: range.startLineNumber,
              end: range.endLineNumber,
              side: 'additions'
            })
          )
    })
    const start = (event: PointerEvent) => {
      if (
        event.button === 0 &&
        event
          .composedPath()
          .some((node) => node instanceof Element && node.hasAttribute('data-column-number'))
      ) {
        pointer.current = {
          id: event.pointerId,
          utility: event
            .composedPath()
            .some((node) => node instanceof Element && node.hasAttribute('data-utility-button'))
        }
      }
    }
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && pointer.current) {
        document.dispatchEvent(new PointerEvent('pointercancel', { pointerId: pointer.current.id }))
        pointer.current = null
        view.current?.instance.setSelectedLines(null)
        event.preventDefault()
        event.stopPropagation()
      }
    }
    const finish = () => {
      const ended = pointer.current
      // Pierre finishes gutter selection in a later listener on the same event.
      queueMicrotask(() => {
        if (pointer.current === ended) {
          pointer.current = null
        }
      })
    }
    container.addEventListener('pointerdown', start, true)
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', finish)
    document.addEventListener('keydown', cancel, true)
    return () => {
      stopShortcut()
      container.removeEventListener('pointerdown', start, true)
      document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', finish)
      document.removeEventListener('keydown', cancel, true)
    }
  }, [containerRef, editorRef, onAddComment, addComment, pendingComment])
  const onLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      if (pointer.current && !pointer.current.utility) {
        addComment(range)
      }
      pointer.current = null
    },
    [addComment]
  )
  const onPostRender = useCallback(
    (host: HTMLElement, phase: PostRenderPhase, instance: PierreDiffInstance) => {
      view.current = phase === 'unmount' ? null : { host, instance }
    },
    []
  )
  return { addComment, onLineSelectionEnd, onPostRender }
}
