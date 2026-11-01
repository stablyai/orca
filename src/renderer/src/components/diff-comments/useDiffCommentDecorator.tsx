import { createDiffCommentVisibility } from './diff-comment-visibility'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { editor as monacoEditor } from 'monaco-editor'
import { createRoot, type Root } from 'react-dom/client'
import { getCommentBodyLayoutLineCount } from '@/lib/comment-body-line-count'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  installDiffCommentAddButtonOverlay,
  type DiffCommentAddButtonOverlayHandle
} from './diff-comment-add-button-overlay'
import { installDiffCommentAddNoteShortcut } from './diff-comment-add-note-shortcut'
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
import type { DiffCommentLineRange, DiffCommentLineTarget } from './diff-comment-line-range'
import { useDiffCommentDraftZone, type DiffCommentDraft } from './diff-comment-draft-zone'

export type { DiffCommentDraft }

type DecoratorArgs = {
  editor: monacoEditor.ICodeEditor | null
  // Monaco destroys model-scoped view zones on model swap, so rebuild even though the editor object is stable.
  monacoModelIdentity?: string
  filePath: string
  worktreeId: string
  comments: readonly DecoratedDiffComment[]
  commentableLineNumbers?: readonly number[]
  addButtonLabel?: string
  pendingCommentTarget?: DiffCommentLineTarget | null
  // Markdown editors already bind this chord through their input bindings.
  addNoteShortcutEnabled?: boolean
  onCreateComment?: (args: {
    lineNumber: number
    startLine?: number
    body: string
  }) => Promise<boolean>
  draftPlaceholder?: string
  draftSubmitLabel?: string
  canOpenDraft?: boolean
  onAddCommentClick?: (args: { lineNumber: number; startLine?: number; top: number }) => void
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
  addButtonLabel = translate(
    'auto.components.diff.comments.DiffCommentPopover.f6c449191e',
    'Add note for the AI'
  ),
  pendingCommentTarget = null,
  addNoteShortcutEnabled = false,
  onCreateComment,
  draftPlaceholder,
  draftSubmitLabel,
  canOpenDraft,
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
  const overlayRef = useRef<DiffCommentAddButtonOverlayHandle | null>(null)
  const pendingCommentRangeRef = useRef<DiffCommentLineRange | null>(null)
  const setPendingCommentRange = useCallback((range: DiffCommentLineRange | null): void => {
    pendingCommentRangeRef.current = range
    overlayRef.current?.setPendingRange(range)
  }, [])
  // Reuse one root per zone so body edits preserve Monaco DOM and selection.
  const zonesRef = useRef<Map<string, ZoneEntry>>(new Map())
  // Read current inline callbacks without tearing down zones on every parent render.
  const onDeleteCommentRef = useRef(onDeleteComment)
  const onUpdateCommentRef = useRef(onUpdateComment)
  const onPendingScrollConsumedRef = useRef(onPendingScrollConsumed)
  onDeleteCommentRef.current = onDeleteComment
  onUpdateCommentRef.current = onUpdateComment
  onPendingScrollConsumedRef.current = onPendingScrollConsumed

  const { onAddCommentClickRef, isDraftOpen } = useDiffCommentDraftZone({
    editor,
    monacoModelIdentity,
    onCreateComment,
    draftPlaceholder,
    draftSubmitLabel,
    canOpenDraft,
    onAddCommentClick
  })

  // Key consumers by line values to avoid refresh churn; memoize the join by array identity because large patches are expensive to scan per render.
  const commentableLineKey = useMemo(
    () => commentableLineNumbers?.join(','),
    [commentableLineNumbers]
  )
  const commentableLineSet = useMemo(
    () => (commentableLineNumbers ? new Set(commentableLineNumbers) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commentableLineKey]
  )

  // Overlay labels and line sets require rebuilds independently of the zone lifecycle below.
  useEffect(() => {
    if (!editor) {
      return
    }

    const editorDomNode = editor.getDomNode()
    if (!editorDomNode) {
      return
    }

    const overlay = installDiffCommentAddButtonOverlay({
      editor,
      editorDomNode,
      addButtonLabel,
      commentableLineSet,
      hoverLineRef,
      onAddCommentClickRef
    })
    overlayRef.current = overlay
    overlay.setPendingRange(pendingCommentRangeRef.current)
    return () => {
      overlayRef.current = null
      overlay.dispose()
    }
  }, [addButtonLabel, commentableLineSet, editor, monacoModelIdentity, onAddCommentClickRef])

  const pendingLineNumber = pendingCommentTarget?.lineNumber ?? null
  const pendingStartLine = pendingCommentTarget?.startLine ?? null
  useEffect(() => {
    const range =
      pendingLineNumber === null
        ? null
        : { startLine: pendingStartLine ?? pendingLineNumber, endLine: pendingLineNumber }
    setPendingCommentRange(range)
  }, [pendingLineNumber, pendingStartLine, setPendingCommentRange])

  const hasDraftComposer = onCreateComment !== undefined
  useEffect(() => {
    if (!editor || !addNoteShortcutEnabled) {
      return
    }
    return installDiffCommentAddNoteShortcut({
      editor,
      commentableLineSet,
      // Open composers and live drags own the chord; reopening at the editor selection would move the draft. Synchronous draft mounting also claims same-turn repeats.
      isComposerOpen: () =>
        isDraftOpen() ||
        pendingCommentRangeRef.current !== null ||
        overlayRef.current?.isDragging() === true,
      onOpenComposer: (args) => {
        // Legacy popovers commit through React: claim same-turn repeats until their target clears. Inline drafts have no target to release this claim.
        if (!hasDraftComposer) {
          setPendingCommentRange({
            startLine: args.startLine ?? args.lineNumber,
            endLine: args.lineNumber
          })
        }
        onAddCommentClickRef.current(args)
      }
    })
  }, [
    addNoteShortcutEnabled,
    commentableLineSet,
    editor,
    hasDraftComposer,
    isDraftOpen,
    monacoModelIdentity,
    onAddCommentClickRef,
    setPendingCommentRange
  ])

  const requestedThreadRef = useRef(pendingScrollCommentId)
  requestedThreadRef.current = pendingScrollCommentId
  const threadRequestRef = useRef<string | null | undefined>(undefined)
  const threadExists = comments.some(
    (comment) =>
      comment.id === pendingScrollCommentId &&
      comment.filePath === filePath &&
      comment.worktreeId === worktreeId
  )
  useEffect(() => {
    if (!pendingScrollCommentId) {
      threadRequestRef.current = pendingScrollCommentId
      return
    }
    if (!editor || !threadExists || threadRequestRef.current === pendingScrollCommentId) {
      return
    }
    threadRequestRef.current = pendingScrollCommentId
    const visibility = createDiffCommentVisibility(editor, () =>
      zonesRef.current.get(pendingScrollCommentId)
    )
    visibility.reveal(undefined, false, () => {
      if (requestedThreadRef.current === pendingScrollCommentId) {
        onPendingScrollConsumedRef.current?.()
      }
    })
    return visibility.cancel
  }, [editor, filePath, worktreeId, monacoModelIdentity, pendingScrollCommentId, threadExists])

  // Deps must stay a subset of the zone-creating effect's, or a teardown here is never followed by a rebuild.
  useEffect(() => {
    if (!editor) {
      return
    }

    const zones = zonesRef.current

    return () => {
      // Clear zones synchronously; defer root unmounts until after React 19’s commit to avoid unmount-while-rendering warnings.
      const rootsToUnmount = Array.from(zones.values(), (z) => {
        z.visibility?.cancel()
        z.disposeMouseDownStopper()
        return z.root
      })
      // Remove Monaco zones too; clearing tracking alone strands blank gaps in a live editor.
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
    }
  }, [editor, monacoModelIdentity])

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
      entry.visibility?.update()
    }

    const renderCard = (root: Root, comment: DecoratedDiffComment): void => {
      renderDiffCommentZoneCard(root, comment, {
        worktreeId,
        filePath,
        activeGroupId,
        formatCommentPrompt,
        resizeZone,
        visibility: zones.get(comment.id)?.visibility,
        onDeleteCommentRef,
        onUpdateCommentRef,
        clearDeliveredDiffComments
      })
    }

    editor.changeViewZones((accessor) => {
      // Keep surviving zones to preserve focus and selection.
      for (const [commentId, entry] of zones) {
        if (!relevantMap.has(commentId)) {
          entry.visibility?.cancel()
          accessor.removeZone(entry.zoneId)
          entry.disposeMouseDownStopper()
          rootsToUnmount.push(entry.root)
          zones.delete(commentId)
        }
      }

      for (const c of relevant) {
        if (zones.has(c.id)) {
          continue
        }
        const dom = document.createElement('div')
        dom.className = 'orca-diff-comment-inline'
        // Stop editor selection/focus theft while allowing card button clicks.
        const disposeMouseDownStopper = installDiffCommentZoneMouseDownStopper(dom)

        const root = createRoot(dom)

        // Monaco never remeasures inserted zones; underestimate and the card overlaps the next line.
        const lineCount = getCommentBodyLayoutLineCount(c.body)
        const heightInPx = Math.max(ZONE_MIN_PX, ZONE_CHROME_PX + lineCount * ZONE_LINE_PX)

        // Let card DOM receive mouse events instead of routing them to Monaco.
        const commentId = c.id
        const delegate: monacoEditor.IViewZone = {
          afterLineNumber: c.lineNumber,
          heightInPx,
          domNode: dom,
          suppressMouseDown: false,
          // The first layout callback resolves waiting scroll requests without polling.
          onDomNodeTop: () => {
            const entry = zones.get(commentId)
            if (!entry) {
              return
            }
            entry.visibility?.update()
          }
        }
        const zoneId = accessor.addZone(delegate)
        const visibility = createDiffCommentVisibility(editor, () => zones.get(c.id))
        zones.set(c.id, {
          visibility,
          zoneId,
          domNode: dom,
          delegate,
          root,
          disposeMouseDownStopper,
          lastRenderSignature: getRenderSignature(c, formatCommentPrompt)
        })
        renderCard(root, c)
      }

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

    if (rootsToUnmount.length > 0) {
      queueMicrotask(() => {
        for (const root of rootsToUnmount) {
          root.unmount()
        }
      })
    }
    // Teardown belongs to the editor-scoped effect; per-comment cleanup would wipe every zone and flicker.
  }, [
    activeGroupId,
    clearDeliveredDiffComments,
    comments,
    editor,
    filePath,
    formatCommentPrompt,
    monacoModelIdentity,
    worktreeId
  ])
}
