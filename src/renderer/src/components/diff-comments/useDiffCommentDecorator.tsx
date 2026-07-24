/* eslint-disable max-lines -- Why: this hook owns Monaco view-zone lifecycle, inline React roots, range selection, and scroll coordination in one place. */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import * as monaco from 'monaco-editor'
import type { editor as monacoEditor, IDisposable } from 'monaco-editor'
import { createRoot, type Root } from 'react-dom/client'
import type { DiffComment } from '../../../../shared/types'
import { getCommentBodyLayoutLineCount } from '@/lib/comment-body-line-count'
import { getDiffCommentLineLabel } from '@/lib/diff-comment-compat'
import { formatDiffComments } from '@/lib/diff-comments-format'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DiffCommentCard } from './DiffCommentCard'
import { getDiffCommentPopoverTop } from './diff-comment-popover-position'
import { installDiffCommentZoneMouseDownStopper } from './diff-comment-zone-mouse-events'
import { NotesSendMenu, type NotesSendMenuScope } from '../editor/NotesSendMenu'
import { translate } from '@/i18n/i18n'

// Monaco glyph decorations don't expose usable click events, so we own an absolutely-positioned "+" button that follows the hovered line.

export type DecoratedDiffComment = DiffComment & {
  author?: string
  authorAvatarUrl?: string
  createdAtLabel?: string
  url?: string
  canDelete?: boolean
  canEdit?: boolean
}

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

type ZoneEntry = {
  zoneId: string
  domNode: HTMLElement
  // Hold the delegate so layoutZone re-reads our updated heightInPx — mutating the delegate is the supported way to resize a zone in place.
  delegate: monacoEditor.IViewZone
  root: Root
  disposeMouseDownStopper: () => void
  lastRenderSignature: string
  // First onDomNodeTop = deterministic "zone laid out" signal; gates scroll-to-note instead of polling getTopForLineNumber.
  laidOut: boolean
}

// Card chrome + per-line body height; used by the initial estimate and the live resize, so keep in lockstep.
const ZONE_CHROME_PX = 68
const ZONE_LINE_PX = 20
const ZONE_MIN_PX = 88

function getRenderSignature(
  comment: DecoratedDiffComment,
  formatCommentPrompt?: (comment: DecoratedDiffComment) => string
): string {
  return JSON.stringify({
    body: comment.body,
    sentAt: comment.sentAt ?? null,
    author: comment.author ?? null,
    authorAvatarUrl: comment.authorAvatarUrl ?? null,
    createdAtLabel: comment.createdAtLabel ?? null,
    url: comment.url ?? null,
    canDelete: comment.canDelete ?? null,
    canEdit: comment.canEdit ?? null,
    sendPrompt: formatCommentPrompt ? formatCommentPrompt(comment) : null
  })
}

function getSingleCommentSendScopes(
  comment: DecoratedDiffComment,
  formatCommentPrompt?: (comment: DecoratedDiffComment) => string
): NotesSendMenuScope<DecoratedDiffComment>[] {
  return [
    {
      id: 'note',
      label: translate(
        'auto.components.diff.comments.useDiffCommentDecorator.995fa28b50',
        'This note'
      ),
      notes: comment.sentAt ? [] : [comment],
      prompt: formatCommentPrompt ? formatCommentPrompt(comment) : formatDiffComments([comment])
    }
  ]
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

  const commentableLineSet = useMemo(
    () => (commentableLineNumbers ? new Set(commentableLineNumbers) : null),
    [commentableLineNumbers]
  )

  useEffect(() => {
    if (!editor) {
      return
    }

    const editorDomNode = editor.getDomNode()
    if (!editorDomNode) {
      return
    }

    const zones = zonesRef.current
    const plus = document.createElement('button')
    plus.type = 'button'
    plus.className = 'orca-diff-comment-add-btn'
    plus.title = addButtonLabel
    plus.setAttribute('aria-label', addButtonLabel)
    plus.innerHTML =
      '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>'
    plus.style.display = 'none'
    editorDomNode.appendChild(plus)

    const getLineHeight = (): number => {
      const h = editor.getOption(monaco.editor.EditorOption.lineHeight)
      return typeof h === 'number' && h > 0 ? h : 19
    }

    // Cache last-applied styles so positionAtLine skips redundant DOM writes on high-freq mousemove (restyling under the cursor flickers).
    let lastTop: number | null = null
    let lastDisplay: string | null = null

    const setDisplay = (value: string): void => {
      if (lastDisplay === value) {
        return
      }
      plus.style.display = value
      lastDisplay = value
    }

    // Fixed 18px square centered in the line box — tracking line-height made a rectangle on taller line-heights.
    const BUTTON_SIZE = 18
    let rangeDecorationIds: string[] = []
    let dragState: { startLine: number; endLine: number } | null = null

    const clearRangeDecoration = (): void => {
      if (rangeDecorationIds.length > 0) {
        rangeDecorationIds = editor.deltaDecorations(rangeDecorationIds, [])
      }
    }

    const updateRangeDecoration = (startLine: number, endLine: number): void => {
      const from = Math.min(startLine, endLine)
      const to = Math.max(startLine, endLine)
      rangeDecorationIds = editor.deltaDecorations(rangeDecorationIds, [
        {
          range: new monaco.Range(from, 1, to, 1),
          options: {
            isWholeLine: true,
            className: 'orca-diff-comment-range-highlight'
          }
        }
      ])
    }

    const getLineAtClientPoint = (clientX: number, clientY: number): number | null => {
      return editor.getTargetAtClientPoint(clientX, clientY)?.position?.lineNumber ?? null
    }

    const canCommentOnLine = (lineNumber: number): boolean => {
      return commentableLineSet === null || commentableLineSet.has(lineNumber)
    }

    const canCommentOnRange = (startLine: number, endLine: number): boolean => {
      if (commentableLineSet === null) {
        return true
      }
      const from = Math.min(startLine, endLine)
      const to = Math.max(startLine, endLine)
      for (let line = from; line <= to; line++) {
        if (!commentableLineSet.has(line)) {
          return false
        }
      }
      return true
    }

    const positionAtLine = (lineNumber: number): void => {
      const lineTop = editor.getTopForLineNumber(lineNumber) - editor.getScrollTop()
      const top = Math.round(lineTop + (getLineHeight() - BUTTON_SIZE) / 2)
      if (top !== lastTop) {
        plus.style.top = `${top}px`
        lastTop = top
      }
      setDisplay('flex')
    }

    const finishRangeDrag = (ev: MouseEvent): void => {
      ev.preventDefault()
      ev.stopPropagation()
      document.removeEventListener('mousemove', handleRangeDragMove)
      document.removeEventListener('mouseup', finishRangeDrag)
      const currentDrag = dragState
      dragState = null
      clearRangeDecoration()
      if (!currentDrag) {
        return
      }
      if (!canCommentOnRange(currentDrag.startLine, currentDrag.endLine)) {
        return
      }
      const startLine = Math.min(currentDrag.startLine, currentDrag.endLine)
      const lineNumber = Math.max(currentDrag.startLine, currentDrag.endLine)
      const top = getDiffCommentPopoverTop(editor, lineNumber, getLineHeight())
      if (top == null) {
        return
      }
      onAddCommentClickRef.current({
        lineNumber,
        startLine: startLine === lineNumber ? undefined : startLine,
        top
      })
    }

    const handleRangeDragMove = (ev: MouseEvent): void => {
      if (!dragState) {
        return
      }
      const line = getLineAtClientPoint(ev.clientX, ev.clientY)
      if (
        line == null ||
        line === dragState.endLine ||
        !canCommentOnLine(line) ||
        !canCommentOnRange(dragState.startLine, line)
      ) {
        return
      }
      dragState = { ...dragState, endLine: line }
      updateRangeDecoration(dragState.startLine, line)
    }

    const handleMouseDown = (ev: MouseEvent): void => {
      ev.preventDefault()
      ev.stopPropagation()
      const line = hoverLineRef.current
      if (line == null || !canCommentOnLine(line)) {
        return
      }
      dragState = { startLine: line, endLine: line }
      updateRangeDecoration(line, line)
      document.addEventListener('mousemove', handleRangeDragMove)
      document.addEventListener('mouseup', finishRangeDrag)
    }
    plus.addEventListener('mousedown', handleMouseDown)

    const onMouseMove = editor.onMouseMove((e) => {
      // Monaco reports null position over our "+" button; hiding on null would flicker-loop, so keep it visible while the cursor's on it.
      const srcEvent = e.event?.browserEvent as MouseEvent | undefined
      if (srcEvent && plus.contains(srcEvent.target as Node)) {
        return
      }
      const ln = e.target.position?.lineNumber ?? null
      if (ln == null || !canCommentOnLine(ln)) {
        hoverLineRef.current = null
        setDisplay('none')
        return
      }
      hoverLineRef.current = ln
      positionAtLine(ln)
    })
    // Keep hoverLineRef on mouse-leave: Monaco's content-area leave fires before the button's, so a click in that gap still resolves to the last-hovered line.
    const onMouseLeave = editor.onMouseLeave(() => {
      setDisplay('none')
    })
    const onScroll = editor.onDidScrollChange(() => {
      if (hoverLineRef.current != null) {
        positionAtLine(hoverLineRef.current)
      }
    })

    disposablesRef.current = [onMouseMove, onMouseLeave, onScroll]

    return () => {
      for (const d of disposablesRef.current) {
        d.dispose()
      }
      disposablesRef.current = []
      document.removeEventListener('mousemove', handleRangeDragMove)
      document.removeEventListener('mouseup', finishRangeDrag)
      clearRangeDecoration()
      plus.removeEventListener('mousedown', handleMouseDown)
      plus.remove()
      // Editor swapped/torn down: unmount roots and clear tracking so the next mount starts known-empty.
      // Defer unmount via queueMicrotask: a sync unmount during React's commit triggers React 19's "unmount while rendering" warning; clear zones synchronously.
      const rootsToUnmount = Array.from(zones.values(), (z) => {
        z.disposeMouseDownStopper()
        return z.root
      })
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
  }, [addButtonLabel, cancelScrollToZoneFrame, commentableLineSet, editor, monacoModelIdentity])

  useEffect(() => {
    if (!editor) {
      return
    }

    const relevant = comments.filter((c) => c.filePath === filePath && c.worktreeId === worktreeId)
    const relevantMap = new Map(relevant.map((c) => [c.id, c] as const))

    const zones = zonesRef.current
    // Unmounting a root inside changeViewZones races Monaco's zone bookkeeping; collect roots and unmount after the batch.
    const rootsToUnmount: Root[] = []

    // Re-measure/re-layout the zone: mutate delegate.heightInPx first (Monaco's _layoutZone re-reads it) so inline edit expands without clipping.
    const resizeZone = (commentId: string): void => {
      const entry = zones.get(commentId)
      if (!entry) {
        return
      }
      const child = entry.domNode.firstElementChild
      const wrapperStyle = window.getComputedStyle(entry.domNode)
      const verticalPadding =
        Number.parseFloat(wrapperStyle.paddingTop) + Number.parseFloat(wrapperStyle.paddingBottom)
      // Monaco pins the zone node to its previous height (scrollHeight can't shrink), so measure the rendered card+padding to allow collapse.
      const measured = Math.ceil(
        (child?.getBoundingClientRect().height ?? entry.domNode.scrollHeight) + verticalPadding
      )
      if (measured <= 0) {
        return
      }
      if (entry.delegate.heightInPx === measured) {
        return
      }
      entry.delegate.heightInPx = measured
      editor.changeViewZones((acc) => {
        acc.layoutZone(entry.zoneId)
      })
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
      root.render(
        // View zones are separate React roots outside the app root, so App.tsx context providers don't reach them.
        <TooltipProvider delayDuration={400}>
          <DiffCommentCard
            lineNumber={comment.lineNumber}
            startLine={comment.startLine}
            label={comment.author ? getDiffCommentLineLabel(comment).toLowerCase() : undefined}
            body={comment.body}
            sentAt={comment.sentAt}
            author={comment.author}
            createdAtLabel={comment.createdAtLabel}
            url={comment.url}
            onDelete={
              comment.canDelete === false ? undefined : () => onDeleteCommentRef.current(comment.id)
            }
            onSubmitEdit={
              onUpdateCommentRef.current && comment.canEdit !== false
                ? async (body) => {
                    const fn = onUpdateCommentRef.current
                    if (!fn) {
                      return false
                    }
                    return fn(comment.id, body)
                  }
                : undefined
            }
            onContentResize={() => resizeZone(comment.id)}
            headerActions={
              worktreeId && comment.author === undefined ? (
                <NotesSendMenu
                  worktreeId={worktreeId}
                  groupId={activeGroupId}
                  modeIdParts={['diff-comment-note', worktreeId, filePath, comment.id]}
                  scopes={getSingleCommentSendScopes(comment, formatCommentPrompt)}
                  targetModeLabel="This note"
                  triggerClassName="orca-diff-comment-edit"
                  disabledTooltip="Note already sent"
                  onDelivered={(notes) => void clearDeliveredDiffComments(worktreeId, notes)}
                />
              ) : null
            }
          />
        </TooltipProvider>
      )
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
