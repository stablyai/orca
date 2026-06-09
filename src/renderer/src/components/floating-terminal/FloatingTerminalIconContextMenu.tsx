import { useCallback, useMemo, useRef, useState } from 'react'
import { EyeOff, PanelBottom, PanelTop } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import type { FloatingTerminalTriggerLocation } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

type FloatingTerminalIconContextMenuProps = {
  children: React.ReactNode
  currentLocation: FloatingTerminalTriggerLocation
  className?: string
  style?: React.CSSProperties
}

export function FloatingTerminalIconContextMenu({
  children,
  currentLocation,
  className,
  style
}: FloatingTerminalIconContextMenuProps): React.JSX.Element {
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [open, setOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const reopenFrameRef = useRef<number | null>(null)

  const setTriggerRef = useCallback((node: HTMLSpanElement | null): void => {
    if (node === null) {
      if (reopenFrameRef.current !== null) {
        window.cancelAnimationFrame(reopenFrameRef.current)
        reopenFrameRef.current = null
      }
    }
  }, [])

  const moveAction = useMemo(() => {
    if (currentLocation === 'floating-button') {
      return {
        icon: <PanelBottom className="size-3.5" />,
        label: translate("auto.components.floating.terminal.FloatingTerminalIconContextMenu.0ee79e0674", "Move to Status Bar"),
        location: 'status-bar' as const
      }
    }
    return {
      icon: <PanelTop className="size-3.5" />,
      label: translate("auto.components.floating.terminal.FloatingTerminalIconContextMenu.763f5fa2c1", "Move to Floating Button"),
      location: 'floating-button' as const
    }
  }, [currentLocation])

  return (
    <>
      <span
        ref={setTriggerRef}
        className={className}
        style={style}
        data-floating-terminal-toggle
        onContextMenuCapture={(event) => {
          // Why: workspace cards use DropdownMenu anchored at the cursor for
          // right-click menus; match that style instead of Radix ContextMenu.
          event.preventDefault()
          event.stopPropagation()
          setMenuPoint({ x: event.clientX, y: event.clientY })
          setOpen(false)
          if (reopenFrameRef.current !== null) {
            window.cancelAnimationFrame(reopenFrameRef.current)
          }
          reopenFrameRef.current = window.requestAnimationFrame(() => {
            reopenFrameRef.current = null
            setOpen(true)
          })
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
      >
        {children}
      </span>
      <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none fixed size-px opacity-0"
            style={{ left: menuPoint.x, top: menuPoint.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-52" sideOffset={0} align="start">
          <DropdownMenuItem
            className="whitespace-nowrap"
            onSelect={() => {
              void updateSettings({ floatingTerminalTriggerLocation: moveAction.location })
            }}
          >
            {moveAction.icon}
            {moveAction.label}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="whitespace-nowrap"
            onSelect={() => {
              void updateSettings({ floatingTerminalEnabled: false })
            }}
          >
            <EyeOff className="size-3.5" />
            {translate("auto.components.floating.terminal.FloatingTerminalIconContextMenu.8e7d775287", "Hide Floating Workspace")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
