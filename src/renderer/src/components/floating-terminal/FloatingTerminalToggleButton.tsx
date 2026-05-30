import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { PanelsTopLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FloatingTerminalIconContextMenu } from './FloatingTerminalIconContextMenu'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import {
  clampFloatingTerminalTriggerPosition,
  getDefaultFloatingTerminalTriggerPosition,
  parseFloatingTerminalTriggerPosition,
  resolveFloatingTerminalTriggerPosition,
  shouldReconcileFloatingTerminalTriggerPosition,
  type FloatingTerminalTriggerPosition,
  type FloatingTerminalTriggerPositionSource
} from './floating-terminal-trigger-position'

// Why: v2 resets older parked positions that sat too low over bottom bars.
const FLOATING_TERMINAL_TRIGGER_POSITION_STORAGE_KEY = 'orca-floating-terminal-trigger-position-v2'
const FLOATING_TERMINAL_TRIGGER_DRAG_THRESHOLD = 4

type FloatingTerminalTriggerPositionState = {
  position: FloatingTerminalTriggerPosition
  source: FloatingTerminalTriggerPositionSource
}

function readInitialTriggerPosition(): FloatingTerminalTriggerPositionState {
  if (typeof window === 'undefined') {
    return {
      position: getDefaultFloatingTerminalTriggerPosition(),
      source: 'default'
    }
  }
  const persistedPosition = parseFloatingTerminalTriggerPosition(
    window.localStorage.getItem(FLOATING_TERMINAL_TRIGGER_POSITION_STORAGE_KEY)
  )
  return persistedPosition
    ? {
        position: persistedPosition,
        source: 'user'
      }
    : {
        position: getDefaultFloatingTerminalTriggerPosition(),
        source: 'default'
      }
}

function persistTriggerPosition(position: FloatingTerminalTriggerPosition): void {
  window.localStorage.setItem(
    FLOATING_TERMINAL_TRIGGER_POSITION_STORAGE_KEY,
    JSON.stringify(position)
  )
}

export function FloatingTerminalToggleButton({
  open,
  onToggle
}: {
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const shortcutLabel = useShortcutLabel('floatingTerminal.toggle')
  const initialPositionState = useRef<FloatingTerminalTriggerPositionState | null>(null)
  if (initialPositionState.current === null) {
    initialPositionState.current = readInitialTriggerPosition()
  }
  const positionSourceRef = useRef<FloatingTerminalTriggerPositionSource>(
    initialPositionState.current.source
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
  const suppressClickRef = useRef(false)

  const updatePosition = useCallback((nextPosition: FloatingTerminalTriggerPosition): void => {
    positionSourceRef.current = 'user'
    const clamped = clampFloatingTerminalTriggerPosition(nextPosition)
    setPosition(clamped)
    persistTriggerPosition(clamped)
  }, [])

  const reconcilePosition = useCallback((): void => {
    setPosition((current) => {
      if (!shouldReconcileFloatingTerminalTriggerPosition(positionSourceRef.current)) {
        // Why: a startup-size viewport must not overwrite an intentional saved
        // drag position with the safety clamp before the renderer finishes sizing.
        return current
      }
      const next = resolveFloatingTerminalTriggerPosition(current, positionSourceRef.current)
      if (positionSourceRef.current === 'user') {
        persistTriggerPosition(next)
      }
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
    updatePosition({
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
            size="icon-sm"
            className="cursor-grab border-border bg-secondary text-secondary-foreground shadow-xs hover:bg-accent hover:text-accent-foreground active:cursor-grabbing"
            data-floating-terminal-toggle
            aria-label={open ? 'Minimize floating workspace' : 'Show floating workspace'}
            aria-pressed={open}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            onClick={handleClick}
          >
            <PanelsTopLeft className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent
          side="left"
          sideOffset={6}
        >{`${open ? 'Minimize' : 'Show'} floating workspace (${shortcutLabel})`}</TooltipContent>
      </Tooltip>
    </FloatingTerminalIconContextMenu>
  )
}
