import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { AgentDotState } from '@/components/AgentStateDot'
import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { CanvasTerminalCardHeader } from './CanvasTerminalCardHeader'
import { terminalCanvasBodyAnchorName } from './tab-group-body-anchor'
import {
  PANE_CANVAS_MIN_HEIGHT,
  PANE_CANVAS_MIN_WIDTH,
  resolvePaneCanvasDrop,
  type PaneCanvasBounds
} from './pane-canvas-layout-state'

export type CanvasTerminalItem = {
  terminalTabId: string
  unifiedTabId: string
  groupId: string
  label: string
  color: string | null
  /** Global canvases retain each terminal's workspace ownership. */
  worktreeId?: string
  executionHostId?: ExecutionHostId
  /** Stable cross-workspace identity used for pinning and saved arrangements. */
  sessionKey?: string
  ownerLabel?: string
  agentState?: AgentDotState
  agentCount?: number
  subagentCount?: number
  pinned?: boolean
}

type CanvasGesture = 'move' | 'resize-x' | 'resize-y' | 'resize-both'

function applyCardBounds(element: HTMLElement, bounds: PaneCanvasBounds): void {
  element.style.left = `${bounds.x}px`
  element.style.top = `${bounds.y}px`
  element.style.width = `${bounds.width}px`
  element.style.height = `${bounds.height}px`
}

export default function CanvasTerminalCard({
  item,
  worktreeId,
  bounds,
  otherBounds,
  isFocused,
  onActivate,
  onCreateTerminal,
  onTogglePinned,
  onClose,
  onCommitBounds
}: {
  item: CanvasTerminalItem
  worktreeId: string
  bounds: PaneCanvasBounds
  otherBounds: readonly PaneCanvasBounds[]
  isFocused: boolean
  onActivate: (item: CanvasTerminalItem) => void
  onCreateTerminal?: (groupId: string) => void
  onTogglePinned?: (item: CanvasTerminalItem) => void
  onClose?: (terminalTabId: string) => void
  onCommitBounds: (bounds: PaneCanvasBounds) => void
}): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const liveBoundsRef = useRef(bounds)
  const gestureCleanupRef = useRef<(() => void) | null>(null)
  const bodyAnchorName = terminalCanvasBodyAnchorName(item.terminalTabId)
  const bodyAnchorStyle = useMemo(
    () => ({ anchorName: bodyAnchorName }) as React.CSSProperties,
    [bodyAnchorName]
  )

  useEffect(() => {
    liveBoundsRef.current = bounds
  }, [bounds])

  useEffect(
    () => () => {
      gestureCleanupRef.current?.()
    },
    []
  )

  const beginGesture = useCallback(
    (event: React.PointerEvent<HTMLElement>, gesture: CanvasGesture) => {
      if (event.button !== 0 || gestureCleanupRef.current) {
        return
      }
      const card = cardRef.current
      if (!card) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      onActivate(item)

      const handle = event.currentTarget
      const pointerId = event.pointerId
      const startPointer = { x: event.clientX, y: event.clientY }
      const startBounds = liveBoundsRef.current
      handle.setPointerCapture(pointerId)

      const update = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId || !handle.hasPointerCapture(pointerId)) {
          return
        }
        const deltaX = moveEvent.clientX - startPointer.x
        const deltaY = moveEvent.clientY - startPointer.y
        const resizingX = gesture === 'resize-x' || gesture === 'resize-both'
        const resizingY = gesture === 'resize-y' || gesture === 'resize-both'
        const next: PaneCanvasBounds = {
          x: gesture === 'move' ? Math.max(0, startBounds.x + deltaX) : startBounds.x,
          y: gesture === 'move' ? Math.max(0, startBounds.y + deltaY) : startBounds.y,
          width: resizingX
            ? Math.max(PANE_CANVAS_MIN_WIDTH, startBounds.width + deltaX)
            : startBounds.width,
          height: resizingY
            ? Math.max(PANE_CANVAS_MIN_HEIGHT, startBounds.height + deltaY)
            : startBounds.height
        }
        liveBoundsRef.current = next
        applyCardBounds(card, next)
      }

      let cleaned = false
      const cleanup = (): void => {
        if (cleaned) {
          return
        }
        cleaned = true
        try {
          if (handle.hasPointerCapture(pointerId)) {
            handle.releasePointerCapture(pointerId)
          }
        } catch {
          // Chromium can drop pointer capture before unmount cleanup.
        }
        handle.removeEventListener('pointermove', update)
        handle.removeEventListener('pointerup', finish)
        handle.removeEventListener('pointercancel', cancel)
        handle.removeEventListener('lostpointercapture', finish)
        if (gestureCleanupRef.current === cleanup) {
          gestureCleanupRef.current = null
        }
      }

      const finish = (finishEvent: PointerEvent): void => {
        if (cleaned || finishEvent.pointerId !== pointerId) {
          return
        }
        const committed = resolvePaneCanvasDrop(liveBoundsRef.current, otherBounds)
        liveBoundsRef.current = committed
        applyCardBounds(card, committed)
        cleanup()
        onCommitBounds(committed)
      }

      const cancel = (cancelEvent: PointerEvent): void => {
        if (cancelEvent.pointerId !== pointerId) {
          return
        }
        liveBoundsRef.current = startBounds
        applyCardBounds(card, startBounds)
        cleanup()
      }

      handle.addEventListener('pointermove', update)
      handle.addEventListener('pointerup', finish)
      handle.addEventListener('pointercancel', cancel)
      handle.addEventListener('lostpointercapture', finish)
      gestureCleanupRef.current = cleanup
    },
    [item, onActivate, onCommitBounds, otherBounds]
  )

  const moveFromHeader = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const target = event.target
      if (!(target instanceof Node) || !event.currentTarget.contains(target)) {
        return
      }
      if (
        target instanceof Element &&
        target.closest(
          'button, a, input, textarea, select, [role="button"], [role="tab"], [contenteditable="true"]'
        )
      ) {
        return
      }
      beginGesture(event, 'move')
    },
    [beginGesture]
  )

  const resizeFromKeyboard = useCallback(
    (event: React.KeyboardEvent<HTMLElement>, axis: 'width' | 'height') => {
      const step = event.shiftKey ? 64 : 16
      const delta =
        axis === 'width'
          ? event.key === 'ArrowRight'
            ? step
            : event.key === 'ArrowLeft'
              ? -step
              : null
          : event.key === 'ArrowDown'
            ? step
            : event.key === 'ArrowUp'
              ? -step
              : null
      if (delta === null) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      onActivate(item)
      const current = liveBoundsRef.current
      const resized: PaneCanvasBounds = {
        ...current,
        width:
          axis === 'width' ? Math.max(PANE_CANVAS_MIN_WIDTH, current.width + delta) : current.width,
        height:
          axis === 'height'
            ? Math.max(PANE_CANVAS_MIN_HEIGHT, current.height + delta)
            : current.height
      }
      const next = resolvePaneCanvasDrop(resized, otherBounds)
      liveBoundsRef.current = next
      const card = cardRef.current
      if (card) {
        applyCardBounds(card, next)
      }
      onCommitBounds(next)
    },
    [item, onActivate, onCommitBounds, otherBounds]
  )

  return (
    <div
      ref={cardRef}
      className={`absolute left-0 top-0 flex flex-col overflow-hidden rounded-md border bg-card shadow-xs${
        isFocused ? ' border-ring ring-1 ring-ring/80' : ' border-border/90 ring-1 ring-border/50'
      }`}
      style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}
      data-pane-canvas-terminal-id={item.terminalTabId}
      data-pane-canvas-group-id={item.groupId}
    >
      <CanvasTerminalCardHeader
        item={item}
        worktreeId={worktreeId}
        onHeaderPointerDown={moveFromHeader}
        onMovePointerDown={(event) => beginGesture(event, 'move')}
        onCreateTerminal={onCreateTerminal}
        onTogglePinned={onTogglePinned}
        onClose={onClose}
      />
      <div
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-b-md"
        data-terminal-canvas-body-id={item.terminalTabId}
        data-tab-group-body-id={item.groupId}
        data-worktree-id={worktreeId}
        style={bodyAnchorStyle}
        onPointerDown={() => onActivate(item)}
      />
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-valuemin={PANE_CANVAS_MIN_WIDTH}
        aria-valuemax={10_000}
        aria-valuenow={Math.round(bounds.width)}
        aria-label={translate(
          'auto.components.tab.group.TabGroupCanvasLayout.resizePaneWidth',
          'Resize terminal width'
        )}
        className="absolute inset-y-8 right-0 z-30 w-2 cursor-ew-resize touch-none bg-transparent focus-visible:bg-ring/60 focus-visible:outline-none"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onPointerDown={(event) => beginGesture(event, 'resize-x')}
        onKeyDown={(event) => resizeFromKeyboard(event, 'width')}
      />
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-valuemin={PANE_CANVAS_MIN_HEIGHT}
        aria-valuemax={10_000}
        aria-valuenow={Math.round(bounds.height)}
        aria-label={translate(
          'auto.components.tab.group.TabGroupCanvasLayout.resizePaneHeight',
          'Resize terminal height'
        )}
        className="absolute inset-x-0 bottom-0 z-30 h-2 cursor-ns-resize touch-none bg-transparent focus-visible:bg-ring/60 focus-visible:outline-none"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onPointerDown={(event) => beginGesture(event, 'resize-y')}
        onKeyDown={(event) => resizeFromKeyboard(event, 'height')}
      />
      <div
        aria-hidden="true"
        data-pane-canvas-resize-corner="true"
        className="absolute bottom-0 right-0 z-40 size-4 cursor-nwse-resize touch-none rounded-br-md bg-transparent"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onPointerDown={(event) => beginGesture(event, 'resize-both')}
      />
    </div>
  )
}
