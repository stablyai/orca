import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { editor as monacoEditor, IDisposable } from 'monaco-editor'
import { createRoot, type Root } from 'react-dom/client'
import { getCommentBodyLayoutLineCount } from '@/lib/comment-body-line-count'
import { useAppStore } from '@/store'
import { installDiffCommentAddButtonOverlay } from './diff-comment-add-button-overlay'
import { installDiffCommentZoneMouseDownStopper } from './diff-comment-zone-mouse-events'
import { getRenderSignature, renderDiffCommentZoneCard } from './diff-comment-zone-card'
import type { DecoratedDiffComment } from './decorated-diff-comment'
import {
  resizeDiffCommentZone,
  ZONE_CHROME_PX,
  ZONE_LINE_PX,
  ZONE_MIN_PX,
  type ZoneEntry
} from './diff-comment-view-zone-entry'

type DecoratorArgs = {
  editor: monacoEditor.ICodeEditor | null
  // Monaco destroys model-scoped view zones on model swap, so rebuild even though the editor object is stable.
  monacoModelIdentity?: string
  filePath: string
  worktreeId: string
  comments: readonly DecoratedDiffComment[]
  commentableLineNumbers?: readonly number[]
  addButtonLabel?: string
  onAddCommentClick: (args: { lineNumber: number; startLine?: number; top: number }) => void
  onDeleteComment: (commentId: string) => void
  // Present only on surfaces that allow editing (local diffs); PR review notes are remote and can't be edited here.
  onUpdateComment?: (commentId: string, body: string) => Promise<boolean>
  formatCommentPrompt?: (comment: DecoratedDiffComment) => string
  // Pending scroll-to-note id from the sidebar; decorator reveals the line and acks so the same id can be re-requested later.
  pendingScrollCommentId?: string | null
  onPendingScrollConsumed?: () => void
}

export function useDiffCommentDecorator({
  editor,
  monacoModelIdentity,
  filePath,
  worktreeId,
  comments,
  commentableLineNumbers,
  addButtonLabel = 'Add note for the AI',
  onAddCommentClick,
  onDeleteComment,
  onUpdateComment,
  formatCommentPrompt,
  pendingScrollCommentId,
  onPendingScrollConsumed
}: DecoratorArgs): void {
  const clearDeliveredDiffComments = useAppStore((s) => s.clearDeliveredDiffComments)
  const activeGroupId = useAppStore((s) =>
    worktreeId ? (s.activeGroupIdByWorktree[worktreeId] ?? worktreeId) : worktreeId
  )
  const hoverLineRef = useRef<number | null>(null)
  // One React root per view zone: body updates re-render into it so Monaco's zone DOM stays put and only the card contents change.
  const zonesRef = useRef<Map<string, ZoneEntry>>(new Map())
  const disposablesRef = useRef<IDisposable[]>([])
  // Pending scroll-to-note comment id; a ref (not state) so the request survives renders while we wait for layout.
  const pendingScrollRef = useRef<string | null>(null)
  // Stash the diff-zones effect's scrollToZone closure so the request-effect can invoke the latest version.
  const scrollToZoneRef = useRef<((commentId: string) => void) | null>(null)
  const scrollToZoneFrameRef = useRef<number | null>(null)
  // Stash callbacks in refs so the effect doesn't tear down + re-attach on every parent render (parent passes inline arrows) — avoids flicker.
  const onAddCommentClickRef = useRef(onAddCommentClick)
  const onDeleteCommentRef = useRef(onDeleteComment)
  const onUpdateCommentRef = useRef(onUpdateComment)
  const onPendingScrollConsumedRef = useRef(onPendingScrollConsumed)
  onAddCommentClickRef.current = onAddCommentClick
  onDeleteCommentRef.current = onDeleteComment
  onUpdateCommentRef.current = onUpdateComment
  onPendingScrollConsumedRef.current = onPendingScrollConsumed

  const cancelScrollToZoneFrame = useCallback((): void => {
    if (scrollToZoneFrameRef.current === null) {
      return
    }
    cancelAnimationFrame(scrollToZoneFrameRef.current)
    scrollToZoneFrameRef.current = null
  }, [])

  // Key on the values, not the array identity: review surfaces re-fetch PR/MR file data on every
  // refresh and hand us a fresh-but-equal number[], which would otherwise churn every consumer.
  // Memoized on the array identity: the join walks every commentable line of the patch (thousands
  // on a large file) and every mounted diff row runs this hook on every render.
  const commentableLineKey = useMemo(
    () => commentableLineNumbers?.join(','),
    [commentableLineNumbers]
  )
  const commentableLineSet = useMemo(
    () => (commentableLineNumbers ? new Set(commentableLineNumbers) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commentableLineKey]
  )

  // Add-button overlay only: it captures commentableLineSet/addButtonLabel, so it must be rebuilt when
  // either changes. Kept apart from the zone teardown below, whose deps must mirror the zone-creating effect.
  useEffect(() => {
    if (!editor) {
      return
    }

    const editorDomNode = editor.getDomNode()
    if (!editorDomNode) {
      return
    }

    return installDiffCommentAddButtonOverlay({
      editor,
      editorDomNode,
      addButtonLabel,
      commentableLineSet,
      hoverLineRef,
      disposablesRef,
      onAddCommentClickRef
    })
  }, [addButtonLabel, commentableLineSet, editor, monacoModelIdentity])

  // Deps must stay a subset of the zone-creating effect's, or a teardown here is never followed by a rebuild.
  useEffect(() => {
    if (!editor) {
      return
    }

    const zones = zonesRef.current

    return () => {
      // Editor swapped/torn down: unmount roots and clear tracking so the next mount starts known-empty.
      // Defer unmount via queueMicrotask: a sync unmount during React's commit triggers React 19's "unmount while rendering" warning; clear zones synchronously.
      const rootsToUnmount = Array.from(zones.values(), (z) => {
        z.disposeMouseDownStopper()
        return z.root
      })
      // Drop the zones from Monaco too: clearing our map alone would strand them as untracked blank gaps
      // in a still-live editor. No-op when the model already swapped (Monaco dropped them) or the editor is disposed.
      if (zones.size > 0) {
        const zoneIds = Array.from(zones.values(), (z) => z.zoneId)
        editor.changeViewZones((accessor) => {
          for (const zoneId of zoneIds) {
            accessor.removeZone(zoneId)
          }
        })
      }
      zones.clear()
      if (rootsToUnmount.length > 0) {
        queueMicrotask(() => {
          for (const root of rootsToUnmount) {
            root.unmount()
          }
        })
      }
      // Editor gone: drop the in-flight scroll request and resolver closure (captured the now-disposed editor).
      cancelScrollToZoneFrame()
      pendingScrollRef.current = null
      scrollToZoneRef.current = null
    }
  }, [cancelScrollToZoneFrame, editor, monacoModelIdentity])

  useEffect(() => {
    if (!editor) {
      return
    }

    const relevant = comments.filter((c) => c.filePath === filePath && c.worktreeId === worktreeId)
    const relevantMap = new Map(relevant.map((c) => [c.id, c] as const))

    const zones = zonesRef.current
    // Unmounting a root inside changeViewZones races Monaco's zone bookkeeping; collect roots and unmount after the batch.
    const rootsToUnmount: Root[] = []

    const resizeZone = (commentId: string): void => {
      const entry = zones.get(commentId)
      if (!entry) {
        return
      }
      resizeDiffCommentZone(editor, entry)
    }

    // One-shot scroll resolver: getTopForLineNumber(line, includeZones=true) centers on the line+card pair (card sits in a zone above the line).
    // rAF defer is intentional: run after DiffViewer's restoreViewState rAF so its cached scroll doesn't snap us back off the note.
    const scrollToZone = (commentId: string): void => {
      cancelScrollToZoneFrame()
      scrollToZoneFrameRef.current = requestAnimationFrame(() => {
        scrollToZoneFrameRef.current = null
        const entry = zones.get(commentId)
        if (!entry || !editor.getModel()) {
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
    scrollToZoneRef.current = scrollToZone

    // Shared by the new-zone and patch branches so the card's prop wiring stays in lockstep.
    const renderCard = (root: Root, comment: DecoratedDiffComment): void => {
      renderDiffCommentZoneCard(root, comment, {
        worktreeId,
        filePath,
        activeGroupId,
        formatCommentPrompt,
        resizeZone,
        onDeleteCommentRef,
        onUpdateCommentRef,
        clearDeliveredDiffComments
      })
    }

    editor.changeViewZones((accessor) => {
      // Remove only zones whose comments are gone; rebuilding all caused flicker and dropped focus/selection.
      for (const [commentId, entry] of zones) {
        if (!relevantMap.has(commentId)) {
          accessor.removeZone(entry.zoneId)
          entry.disposeMouseDownStopper()
          rootsToUnmount.push(entry.root)
          zones.delete(commentId)
          // Comment deleted: drop any pending scroll request so a future zone reusing the id can't pick up a stale request.
          if (pendingScrollRef.current === commentId) {
            pendingScrollRef.current = null
          }
        }
      }

      for (const c of relevant) {
        if (zones.has(c.id)) {
          continue
        }
        const dom = document.createElement('div')
        dom.className = 'orca-diff-comment-inline'
        // Swallow mousedown on the zone so the editor doesn't steal focus / start a selection drag; Delete still fires (click is on the button).
        const disposeMouseDownStopper = installDiffCommentZoneMouseDownStopper(dom)

        const root = createRoot(dom)

        // Estimate height up front: Monaco fixes heightInPx at insertion and never re-measures, so an underestimate bleeds into the next line.
        const lineCount = getCommentBodyLayoutLineCount(c.body)
        const heightInPx = Math.max(ZONE_MIN_PX, ZONE_CHROME_PX + lineCount * ZONE_LINE_PX)

        // suppressMouseDown: false so clicks (Delete button) reach our DOM listeners; true would route mousedown to the editor.
        const commentId = c.id
        const delegate: monacoEditor.IViewZone = {
          afterLineNumber: c.lineNumber,
          heightInPx,
          domNode: dom,
          suppressMouseDown: false,
          // First onDomNodeTop = deterministic "zone placed" signal: resolve any waiting scroll and flip laidOut.
          onDomNodeTop: () => {
            const entry = zones.get(commentId)
            if (!entry) {
              return
            }
            const wasLaidOut = entry.laidOut
            entry.laidOut = true
            if (!wasLaidOut && pendingScrollRef.current === commentId) {
              scrollToZone(commentId)
            }
          }
        }
        const zoneId = accessor.addZone(delegate)
        zones.set(c.id, {
          zoneId,
          domNode: dom,
          delegate,
          root,
          disposeMouseDownStopper,
          lastRenderSignature: getRenderSignature(c, formatCommentPrompt),
          laidOut: false
        })
        renderCard(root, c)
      }

      // Patch existing zones in place — re-render the same root instead of removing/re-adding.
      for (const c of relevant) {
        const entry = zones.get(c.id)
        if (!entry) {
          continue
        }
        const renderSignature = getRenderSignature(c, formatCommentPrompt)
        if (entry.lastRenderSignature === renderSignature) {
          continue
        }
        entry.lastRenderSignature = renderSignature
        renderCard(entry.root, c)
      }
    })

    // Deferred unmount so Monaco finishes its zone batch before we tear down the React trees.
    if (rootsToUnmount.length > 0) {
      queueMicrotask(() => {
        for (const root of rootsToUnmount) {
          root.unmount()
        }
      })
    }
    // Intentionally no cleanup: React would wipe all zones on every comments change (flicker). Teardown lives in the editor-scoped effect above.
  }, [
    activeGroupId,
    cancelScrollToZoneFrame,
    clearDeliveredDiffComments,
    editor,
    filePath,
    formatCommentPrompt,
    monacoModelIdentity,
    worktreeId,
    comments
  ])

  // Scroll-to-note resolution splits across this effect (request after layout) and onDomNodeTop (before), via pendingScrollRef.
  useEffect(() => {
    if (!editor) {
      return
    }
    // Null request: drop any in-flight pending id so a late onDomNodeTop doesn't snap-scroll the user.
    if (!pendingScrollCommentId) {
      cancelScrollToZoneFrame()
      pendingScrollRef.current = null
      return
    }
    const target = comments.find(
      (c) =>
        c.id === pendingScrollCommentId && c.filePath === filePath && c.worktreeId === worktreeId
    )
    if (!target) {
      // Not our comment; drop prior pending id so a late onDomNodeTop can't ack another surface's request.
      cancelScrollToZoneFrame()
      pendingScrollRef.current = null
      return
    }
    pendingScrollRef.current = pendingScrollCommentId
    const entry = zonesRef.current.get(pendingScrollCommentId)
    if (entry?.laidOut) {
      scrollToZoneRef.current?.(pendingScrollCommentId)
    }
    // If !laidOut, onDomNodeTop picks up the request once Monaco places the zone.
  }, [
    cancelScrollToZoneFrame,
    editor,
    comments,
    pendingScrollCommentId,
    filePath,
    monacoModelIdentity,
    worktreeId
  ])
}
