import { useMemo, useState } from 'react'
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

type FloatingTerminalIconContextMenuProps = {
  children: React.ReactNode
  currentLocation: FloatingTerminalTriggerLocation
  className?: string
}

export function FloatingTerminalIconContextMenu({
  children,
  currentLocation,
  className
}: FloatingTerminalIconContextMenuProps): React.JSX.Element {
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [open, setOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })

  const moveAction = useMemo(() => {
    if (currentLocation === 'floating-button') {
      return {
        icon: <PanelBottom className="size-3.5" />,
        label: 'Move to Status Bar',
        location: 'status-bar' as const
      }
    }
    return {
      icon: <PanelTop className="size-3.5" />,
      label: 'Move to Floating Button',
      location: 'floating-button' as const
    }
  }, [currentLocation])

  return (
    <>
      <span
        className={className}
        data-floating-terminal-toggle
        onContextMenuCapture={(event) => {
          // Why: workspace cards use DropdownMenu anchored at the cursor for
          // right-click menus; match that style instead of Radix ContextMenu.
          event.preventDefault()
          event.stopPropagation()
          setMenuPoint({ x: event.clientX, y: event.clientY })
          setOpen(false)
          window.requestAnimationFrame(() => setOpen(true))
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
            Hide
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
