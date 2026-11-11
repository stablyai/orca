import type { editor as monacoEditor } from 'monaco-editor'
import { useEffect, type RefObject } from 'react'
import type { DecoratedDiffComment } from './decorated-diff-comment'
import {
  isCombinedEditorBindingCurrent,
  measureCombinedCommentZone,
  registerCombinedCommentZone,
  revealCombinedCommentZone
} from '../editor/combined-diff/scroll-viewport/combined-diff-editor-geometry'
import { resizeDiffCommentZone, type ZoneEntry } from './diff-comment-view-zone-entry'
import { untilDiffCommentZoneRemoved } from './diff-comment-zone-lifetime'

type ZoneNavigationContext = {
  editor: monacoEditor.ICodeEditor
  monacoModelIdentity?: string
  zones: Map<string, ZoneEntry>
  combined: boolean
  pendingScrollRef: RefObject<string | null>
  combinedScrollRequestRef: RefObject<object | null>
  scrollToZoneFrameRef: RefObject<number | null>
  onPendingScrollConsumedRef: RefObject<(() => void) | undefined>
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
    if (resizeDiffCommentZone(editor, entry) && combined) {
      entry.laidOut = true
      if (pendingScrollRef.current === commentId) {
        scrollToZone(commentId)
      }
    }
  }

  // Combined targets are zone-local; the legacy route retains its deferred native centering.
  const scrollToZone = (commentId: string): void => {
    cancelScrollToZoneFrame()
    const entry = zones.get(commentId)
    if (
      !entry ||
      entry.lifetime.signal.aborted ||
      pendingScrollRef.current !== commentId ||
      !isCombinedEditorBindingCurrent(editor, monacoModelIdentity)
    ) {
      return
    }
    if (combined) {
      if (combinedScrollRequestRef.current) {
        return
      }
      measureCombinedCommentZone(editor, entry.zoneId, entry.domNode, () => {
        if (!resizeDiffCommentZone(editor, entry)) {
          return false
        }
        entry.laidOut = true
        const card = entry.domNode.firstElementChild
        if (!(card instanceof HTMLElement) || card.offsetHeight <= 0) {
          return false
        }
        const request = { resolved: false }
        combinedScrollRequestRef.current = request
        const zoneCurrent = (): boolean =>
          zones.get(commentId) === entry &&
          !entry.lifetime.signal.aborted &&
          isCombinedEditorBindingCurrent(editor, monacoModelIdentity)
        const current = (): boolean =>
          combinedScrollRequestRef.current === request &&
          pendingScrollRef.current === commentId &&
          zoneCurrent()
        const accepted = revealCombinedCommentZone({
          editor,
          id: entry.zoneId,
          node: entry.domNode,
          controls: () => (zoneCurrent() && (request.resolved || current()) ? [card] : []),
          focus: () => {
            if (!current()) {
              return
            }
            request.resolved = true
            pendingScrollRef.current = null
            combinedScrollRequestRef.current = null
            onPendingScrollConsumedRef.current?.()
          }
        })
        if (!accepted) {
          combinedScrollRequestRef.current = null
        }
        return accepted
      })
      return
    }
    if (!entry.laidOut) {
      return
    }
    scrollToZoneFrameRef.current = requestAnimationFrame(() => {
      scrollToZoneFrameRef.current = null
      const entry = zones.get(commentId)
      if (!entry || !editor.getModel() || entry.lifetime.signal.aborted) {
        return
      }
      if (pendingScrollRef.current !== commentId) {
        return
      }
      const top = editor.getTopForLineNumber(entry.delegate.afterLineNumber, true)
      const editorHeight = editor.getLayoutInfo().height
      editor.setScrollTop(Math.max(0, top - editorHeight / 2))
      pendingScrollRef.current = null
      onPendingScrollConsumedRef.current?.()
    })
  }
  return { resizeZone, scrollToZone }
}

export function registerDiffCommentZoneReading(
  editor: monacoEditor.ICodeEditor,
  monacoModelIdentity: string | undefined,
  zones: Map<string, ZoneEntry>,
  commentId: string,
  entry: ZoneEntry
): void {
  const { zoneId, domNode: dom, lifetime } = entry
  untilDiffCommentZoneRemoved(
    lifetime.signal,
    registerCombinedCommentZone(editor, zoneId, dom, () => {
      if (
        zones.get(commentId) !== entry ||
        lifetime.signal.aborted ||
        !isCombinedEditorBindingCurrent(editor, monacoModelIdentity)
      ) {
        return []
      }
      const card = dom.firstElementChild
      return card instanceof HTMLElement && card.isConnected ? [card] : []
    })
  )
}

type PendingZoneRevealContext = {
  editor: monacoEditor.ICodeEditor | null
  monacoModelIdentity?: string
  comments: readonly DecoratedDiffComment[]
  filePath: string
  worktreeId: string
  pendingScrollCommentId?: string | null
  pendingScrollRef: RefObject<string | null>
  combinedScrollRequestRef: RefObject<object | null>
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
    // Cancel cleared requests so late layout callbacks cannot snap-scroll.
    if (!pendingScrollCommentId) {
      cancelScrollToZoneFrame()
      pendingScrollRef.current = null
      combinedScrollRequestRef.current = null
      return
    }
    const target = comments.find(
      (c) =>
        c.id === pendingScrollCommentId && c.filePath === filePath && c.worktreeId === worktreeId
    )
    if (!target) {
      // Drop foreign requests so late layout cannot acknowledge another surface’s note.
      cancelScrollToZoneFrame()
      pendingScrollRef.current = null
      combinedScrollRequestRef.current = null
      return
    }
    if (pendingScrollRef.current !== pendingScrollCommentId) {
      combinedScrollRequestRef.current = null
    }
    pendingScrollRef.current = pendingScrollCommentId
    const entry = zonesRef.current.get(pendingScrollCommentId)
    if (entry && (entry.laidOut || !isCombinedEditorBindingCurrent(editor))) {
      scrollToZoneRef.current?.(pendingScrollCommentId)
    }
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
