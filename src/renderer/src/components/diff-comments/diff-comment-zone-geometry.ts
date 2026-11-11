import type { editor as monacoEditor } from 'monaco-editor'
import { useEffect, type RefObject } from 'react'
import type { DecoratedDiffComment } from './decorated-diff-comment'
import {
  isCombinedEditorBindingCurrent,
  measureCombinedCommentZone,
  revealCombinedCommentZone
} from '../editor/combined-diff/scroll-viewport/combined-diff-editor-geometry'
import { resizeDiffCommentZone, type ZoneEntry } from './diff-comment-view-zone-entry'
import { requestDiffCommentZoneMeasurement } from './diff-comment-zone-measurement'
import { useAppStore } from '@/store'
import {
  createDiffCommentScrollCommand,
  type DiffCommentScrollCommand
} from './diff-comment-scroll-command'

type ZoneNavigationContext = {
  editor: monacoEditor.ICodeEditor
  monacoModelIdentity?: string
  zones: Map<string, ZoneEntry>
  combined: boolean
  pendingScrollRef: RefObject<string | null>
  combinedScrollRequestRef: RefObject<DiffCommentScrollCommand | null>
  scrollToZoneFrameRef: RefObject<number | null>
  onPendingScrollConsumedRef: RefObject<((id: string) => void) | undefined>
  cancelScrollToZoneFrame: () => void
}

export function createDiffCommentZoneNavigation({
  editor,
  monacoModelIdentity,
  zones,
  combined,
  pendingScrollRef,
  combinedScrollRequestRef,
  scrollToZoneFrameRef,
  onPendingScrollConsumedRef,
  cancelScrollToZoneFrame
}: ZoneNavigationContext): {
  resizeZone: (commentId: string) => void
  zoneMeasured: (commentId: string) => void
  scrollToZone: (commentId: string) => void
} {
  const resizeZone = (commentId: string): void => {
    const entry = zones.get(commentId)
    if (
      !entry ||
      entry.lifetime.signal.aborted ||
      !isCombinedEditorBindingCurrent(editor, monacoModelIdentity)
    ) {
      return
    }
    if (combined) {
      requestDiffCommentZoneMeasurement(editor, entry)
    } else {
      resizeDiffCommentZone(editor, entry)
    }
  }
  const zoneMeasured = (commentId: string): void => {
    const entry = zones.get(commentId)
    if (
      entry &&
      !entry.lifetime.signal.aborted &&
      isCombinedEditorBindingCurrent(editor, monacoModelIdentity)
    ) {
      entry.laidOut = true
      if (pendingScrollRef.current === commentId) {
        scrollToZone(commentId)
      }
    }
  }

  // Combined targets are zone-local; the legacy route retains its deferred native centering.
  const scrollToZone = (commentId: string): void => {
    const entry = zones.get(commentId)
    if (
      !entry ||
      entry.lifetime.signal.aborted ||
      pendingScrollRef.current !== commentId ||
      useAppStore.getState().scrollToDiffCommentId !== commentId ||
      !isCombinedEditorBindingCurrent(editor, monacoModelIdentity)
    ) {
      return
    }
    if (combinedScrollRequestRef.current) {
      return
    }
    cancelScrollToZoneFrame()
    if (combined) {
      measureCombinedCommentZone(editor, entry.zoneId, entry.domNode, () => {
        if (
          combinedScrollRequestRef.current ||
          pendingScrollRef.current !== commentId ||
          useAppStore.getState().scrollToDiffCommentId !== commentId ||
          zones.get(commentId) !== entry ||
          entry.lifetime.signal.aborted ||
          !isCombinedEditorBindingCurrent(editor, monacoModelIdentity)
        ) {
          return false
        }
        if (!resizeDiffCommentZone(editor, entry)) {
          return false
        }
        entry.laidOut = true
        const card = entry.domNode.firstElementChild
        if (!(card instanceof HTMLElement) || card.offsetHeight <= 0) {
          return false
        }
        let resolved = false
        const request = createDiffCommentScrollCommand(commentId, () => {
          if (combinedScrollRequestRef.current === request) {
            combinedScrollRequestRef.current = null
            if (pendingScrollRef.current === commentId) {
              pendingScrollRef.current = null
            }
            cancelScrollToZoneFrame()
          }
        })
        combinedScrollRequestRef.current = request
        const zoneCurrent = (): boolean =>
          zones.get(commentId) === entry &&
          !entry.lifetime.signal.aborted &&
          isCombinedEditorBindingCurrent(editor, monacoModelIdentity)
        const current = (): boolean =>
          combinedScrollRequestRef.current === request &&
          request.isCurrent() &&
          pendingScrollRef.current === commentId &&
          zoneCurrent()
        const accepted = revealCombinedCommentZone({
          editor,
          id: entry.zoneId,
          node: entry.domNode,
          controls: () => (zoneCurrent() && (resolved || current()) ? [card] : []),
          command: request,
          focus: () => {
            if (!current()) {
              return
            }
            resolved = true
            request.consume(onPendingScrollConsumedRef.current)
          }
        })
        if (!accepted) {
          request.dispose()
        }
        return accepted
      })
      return
    }
    if (!entry.laidOut) {
      return
    }
    const request = createDiffCommentScrollCommand(commentId, () => {
      if (combinedScrollRequestRef.current === request) {
        combinedScrollRequestRef.current = null
        pendingScrollRef.current = null
        cancelScrollToZoneFrame()
      }
    })
    combinedScrollRequestRef.current = request
    scrollToZoneFrameRef.current = requestAnimationFrame(() => {
      scrollToZoneFrameRef.current = null
      const entry = zones.get(commentId)
      if (!entry || !editor.getModel() || entry.lifetime.signal.aborted || !request.isCurrent()) {
        request.dispose()
        return
      }
      if (pendingScrollRef.current !== commentId) {
        return
      }
      const top = editor.getTopForLineNumber(entry.delegate.afterLineNumber, true)
      const editorHeight = editor.getLayoutInfo().height
      editor.setScrollTop(Math.max(0, top - editorHeight / 2))
      request.consume(onPendingScrollConsumedRef.current)
    })
  }
  return { resizeZone, zoneMeasured, scrollToZone }
}

type PendingZoneRevealContext = {
  editor: monacoEditor.ICodeEditor | null
  monacoModelIdentity?: string
  comments: readonly DecoratedDiffComment[]
  filePath: string
  worktreeId: string
  pendingScrollCommentId?: string | null
  pendingScrollRef: RefObject<string | null>
  combinedScrollRequestRef: RefObject<DiffCommentScrollCommand | null>
  zonesRef: RefObject<Map<string, ZoneEntry>>
  scrollToZoneRef: RefObject<((commentId: string) => void) | null>
  cancelScrollToZoneFrame: () => void
}

export function usePendingDiffCommentZoneReveal({
  editor,
  monacoModelIdentity,
  comments,
  filePath,
  worktreeId,
  pendingScrollCommentId,
  pendingScrollRef,
  combinedScrollRequestRef,
  zonesRef,
  scrollToZoneRef,
  cancelScrollToZoneFrame
}: PendingZoneRevealContext): void {
  // Resolve scroll requests here after layout or in onDomNodeTop before layout, sharing pendingScrollRef.
  useEffect(() => {
    if (!editor || !isCombinedEditorBindingCurrent(editor, monacoModelIdentity)) {
      return
    }
    const clearAttempt = (): void => {
      cancelScrollToZoneFrame()
      combinedScrollRequestRef.current?.dispose()
      pendingScrollRef.current = null
      combinedScrollRequestRef.current = null
    }
    if (!pendingScrollCommentId) {
      clearAttempt()
      return
    }
    const target = comments.find(
      (c) =>
        c.id === pendingScrollCommentId && c.filePath === filePath && c.worktreeId === worktreeId
    )
    if (!target) {
      // Drop foreign requests so late layout cannot acknowledge another surface’s note.
      clearAttempt()
      return
    }
    const synchronize = (): void => {
      if (useAppStore.getState().scrollToDiffCommentId !== pendingScrollCommentId) {
        clearAttempt()
        return
      }
      if (pendingScrollRef.current !== pendingScrollCommentId) {
        clearAttempt()
      }
      pendingScrollRef.current = pendingScrollCommentId
      const entry = zonesRef.current.get(pendingScrollCommentId)
      if (entry && (entry.laidOut || !isCombinedEditorBindingCurrent(editor))) {
        scrollToZoneRef.current?.(pendingScrollCommentId)
      }
    }
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.scrollToDiffCommentId !== previous.scrollToDiffCommentId) {
        synchronize()
      }
    })
    synchronize()
    return unsubscribe
  }, [
    cancelScrollToZoneFrame,
    editor,
    comments,
    pendingScrollCommentId,
    filePath,
    monacoModelIdentity,
    worktreeId,
    pendingScrollRef,
    combinedScrollRequestRef,
    zonesRef,
    scrollToZoneRef
  ])
}
