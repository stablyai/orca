import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { PanelsTopLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FloatingTerminalIconContextMenu } from './FloatingTerminalIconContextMenu'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { useAppStore } from '@/store'
import { selectFloatingWorkspaceHasUnread } from '@/store/selectors'
import {
  anchorFloatingTerminalTriggerPosition,
  clampFloatingTerminalTriggerPosition,
  getDefaultFloatingTerminalTriggerCommittedPosition,
  getDefaultFloatingTerminalTriggerPosition,
  persistFloatingTerminalTriggerPosition,
  readPersistedFloatingTerminalTriggerPosition,
  resolveFloatingTerminalTriggerCommittedPosition,
  resolveFloatingTerminalTriggerPosition,
  shouldReconcileFloatingTerminalTriggerPosition,
  type FloatingTerminalTriggerCommittedPosition,
  type FloatingTerminalTriggerPosition,
  type FloatingTerminalTriggerPositionSource
} from './floating-terminal-trigger-position'
import { translate } from '@/i18n/i18n'

const FLOATING_TERMINAL_TRIGGER_DRAG_THRESHOLD = 4

type FloatingTerminalTriggerPositionState = {
  committedPosition: FloatingTerminalTriggerCommittedPosition
  position: FloatingTerminalTriggerPosition
  source: FloatingTerminalTriggerPositionSource
}

function readInitialTriggerPosition(): FloatingTerminalTriggerPositionState {
  const defaultCommittedPosition = getDefaultFloatingTerminalTriggerCommittedPosition()
  const defaultPosition = getDefaultFloatingTerminalTriggerPosition()
  if (typeof window === 'undefined') {
    return {
      committedPosition: defaultCommittedPosition,
      position: defaultPosition,
      source: 'default'
    }
  }
  const persistedPosition = readPersistedFloatingTerminalTriggerPosition()
  return persistedPosition
    ? {
        committedPosition: persistedPosition,
        position: shouldReconcileFloatingTerminalTriggerPosition('user')
          ? resolveFloatingTerminalTriggerPosition(persistedPosition, 'user')
          : resolveFloatingTerminalTriggerCommittedPosition(persistedPosition),
        source: 'user'
      }
    : {
        committedPosition: defaultCommittedPosition,
        position: defaultPosition,
        source: 'default'
      }
}

export function FloatingTerminalToggleButton({
  open,
  onToggle
}: {
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const shortcutLabel = useShortcutLabel('floatingTerminal.toggle')
  // Why: show an attention dot while minimized (closed) when any floating-
  // workspace tab still has an unacknowledged bell or agent completion. Derived
  // from the shared unread maps, so it clears when the user engages with — or
  // closes — the offending tab (see selectFloatingWorkspaceHasUnread).
  const hasFloatingUnread = useAppStore(selectFloatingWorkspaceHasUnread)
  const showAttentionDot = !open && hasFloatingUnread
  const initialPositionState = useRef<FloatingTerminalTriggerPositionState | null>(null)
  if (initialPositionState.current === null) {
    initialPositionState.current = readInitialTriggerPosition()
  }
  const positionSourceRef = useRef<FloatingTerminalTriggerPositionSource>(
    initialPositionState.current.source
  )
  const committedPositionRef = useRef<FloatingTerminalTriggerCommittedPosition>(
    initialPositionState.current.committedPosition
  )
  const [position, setPosition] = useState(initialPositionState.current.position)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    left: number
    top: number
    moved: boolean
  } | null>(null)
  const stagedPositionRef = useRef<FloatingTerminalTriggerPosition | null>(null)
  const suppressClickRef = useRef(false)

  const previewPosition = useCallback((nextPosition: FloatingTerminalTriggerPosition): void => {
    const clamped = clampFloatingTerminalTriggerPosition(nextPosition)
    stagedPositionRef.current = clamped
    setPosition(clamped)
  }, [])

  const commitPosition = useCallback((nextPosition: FloatingTerminalTriggerPosition): void => {
    stagedPositionRef.current = null
    const clamped = clampFloatingTerminalTriggerPosition(nextPosition)
    setPosition(clamped)
    const anchoredPosition = anchorFloatingTerminalTriggerPosition(clamped)
    if (!anchoredPosition) {
      return
    }
    committedPositionRef.current = anchoredPosition
    positionSourceRef.current = 'user'
    persistFloatingTerminalTriggerPosition(anchoredPosition)
  }, [])

  const reconcilePosition = useCallback((): void => {
    setPosition((current) => {
      if (!shouldReconcileFloatingTerminalTriggerPosition(positionSourceRef.current)) {
        // Why: a startup-size viewport must not overwrite an intentional saved
        // drag position with the safety clamp before the renderer finishes sizing.
        return current
      }
      const next = resolveFloatingTerminalTriggerPosition(
        committedPositionRef.current,
        positionSourceRef.current
      )
      return next
    })
  }, [])

  useLayoutEffect(() => {
    // Why: Electron can mount before the renderer has final viewport dimensions;
    // default positions should re-anchor to bottom-right before first paint.
    reconcilePosition()
  }, [reconcilePosition])

  useEffect(() => {
    const handleResize = (): void => reconcilePosition()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [reconcilePosition])

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) {
      return
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: position.left,
      top: position.top,
      moved: false
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < FLOATING_TERMINAL_TRIGGER_DRAG_THRESHOLD) {
      return
    }
    drag.moved = true
    previewPosition({
      left: drag.left + dx,
      top: drag.top + dy
    })
  }

  const handlePointerEnd = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    suppressClickRef.current = drag.moved
    if (drag.moved && stagedPositionRef.current) {
      commitPosition(stagedPositionRef.current)
    }
    dragRef.current = null
  }

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      event.preventDefault()
      event.stopPropagation()
      return
    }
    onToggle()
  }

  return (
    <FloatingTerminalIconContextMenu
      currentLocation="floating-button"
      className="fixed z-40"
      style={{ left: position.left, top: position.top }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            // Why: a parked launcher needs contrast against the page. On light
            // pages a soft drop shadow lifts it; on near-black dark surfaces a
            // drop shadow vanishes, so use a distinctly lighter fill plus a
            // bright hairline ring to define the edge.
            className="relative cursor-grab rounded-lg border-transparent text-foreground bg-card shadow-[0_4px_12px_rgb(0_0_0_/_0.22),0_0_0_1px_color-mix(in_srgb,var(--foreground)_12%,transparent)] hover:-translate-y-0.5 hover:bg-accent active:translate-y-0 active:cursor-grabbing dark:bg-accent dark:shadow-[0_6px_16px_rgb(0_0_0_/_0.55),0_0_0_1px_rgb(255_255_255_/_0.22)] dark:hover:bg-[color-mix(in_srgb,var(--accent)_82%,white)]"
            data-floating-terminal-toggle
            aria-label={
              open
                ? translate(
                    'auto.components.floating.terminal.FloatingTerminalToggleButton.5785dd9148',
                    'Minimize floating workspace'
                  )
                : showAttentionDot
                  ? // Why: announce pending activity to assistive tech; the dot
                    // itself is aria-hidden decoration.
                    translate(
                      'auto.components.floating.terminal.FloatingTerminalToggleButton.4cb418b991',
                      'Show floating workspace, new activity'
                    )
                  : translate(
                      'auto.components.floating.terminal.FloatingTerminalToggleButton.3b04b065b5',
                      'Show floating workspace'
                    )
            }
            aria-pressed={open}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            onClick={handleClick}
          >
            <PanelsTopLeft className="size-4" />
            {showAttentionDot ? (
              // Why: amber matches Orca's "needs attention / unread" convention
              // (the tab-unread bell); the ring matches the button fill so the
              // dot reads on both light (bg-card) and dark (dark:bg-accent).
              <span
                aria-hidden
                data-floating-terminal-attention
                className="pointer-events-none absolute right-1 top-1 size-2 rounded-full bg-amber-500 ring-2 ring-card dark:ring-accent"
              />
            ) : null}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={6}>
          {translate(
            'auto.components.floating.terminal.FloatingTerminalToggleButton.bfe7809a70',
            '{{value0}} floating workspace ({{value1}})',
            { value0: open ? 'Minimize' : 'Show', value1: shortcutLabel }
          )}
        </TooltipContent>
      </Tooltip>
    </FloatingTerminalIconContextMenu>
  )
}
