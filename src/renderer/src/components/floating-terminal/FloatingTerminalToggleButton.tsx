import { useCallback, useEffect, useRef, useState } from 'react'
import { PanelsTopLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FloatingTerminalIconContextMenu } from './FloatingTerminalIconContextMenu'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import {
  clampFloatingTerminalTriggerPosition,
  getDefaultFloatingTerminalTriggerPosition,
  parseFloatingTerminalTriggerPosition,
  type FloatingTerminalTriggerPosition
} from './floating-terminal-trigger-position'

// Why: v2 resets older parked positions that sat too low over bottom bars.
const FLOATING_TERMINAL_TRIGGER_POSITION_STORAGE_KEY = 'orca-floating-terminal-trigger-position-v2'
const FLOATING_TERMINAL_TRIGGER_DRAG_THRESHOLD = 4

function readInitialTriggerPosition(): FloatingTerminalTriggerPosition {
  if (typeof window === 'undefined') {
    return getDefaultFloatingTerminalTriggerPosition()
  }
  return (
    parseFloatingTerminalTriggerPosition(
      window.localStorage.getItem(FLOATING_TERMINAL_TRIGGER_POSITION_STORAGE_KEY)
    ) ?? getDefaultFloatingTerminalTriggerPosition()
  )
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
  const [position, setPosition] = useState(readInitialTriggerPosition)
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
    const clamped = clampFloatingTerminalTriggerPosition(nextPosition)
    setPosition(clamped)
    persistTriggerPosition(clamped)
  }, [])

  useEffect(() => {
    const handleResize = (): void => {
      setPosition((current) => {
        const clamped = clampFloatingTerminalTriggerPosition(current)
        persistTriggerPosition(clamped)
        return clamped
      })
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

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
