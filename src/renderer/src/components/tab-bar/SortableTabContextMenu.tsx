import { Columns2, Pin, PinOff, Rows2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { TerminalTab } from '../../../../shared/types'

const TAB_COLORS = [
  { label: 'None', value: null },
  { label: 'Blue', value: '#3b82f6' },
  { label: 'Purple', value: '#a855f7' },
  { label: 'Pink', value: '#ec4899' },
  { label: 'Red', value: '#ef4444' },
  { label: 'Orange', value: '#f97316' },
  { label: 'Yellow', value: '#eab308' },
  { label: 'Green', value: '#22c55e' },
  { label: 'Teal', value: '#14b8a6' },
  { label: 'Gray', value: '#9ca3af' }
] as const

type SortableTabContextMenuProps = {
  tab: TerminalTab
  open: boolean
  point: { x: number; y: number }
  tabCount: number
  hasTabsToRight: boolean
  isPinned: boolean
  onOpenChange: (open: boolean) => void
  onClose: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseToRight: (tabId: string) => void
  onRenameOpen: () => void
  onSetTabColor: (tabId: string, color: string | null) => void
  onTogglePin: () => void
  onSplitGroup: (direction: 'left' | 'right' | 'up' | 'down', sourceVisibleTabId: string) => void
}

export function SortableTabContextMenu({
  tab,
  open,
  point,
  tabCount,
  hasTabsToRight,
  isPinned,
  onOpenChange,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onRenameOpen,
  onSetTabColor,
  onTogglePin,
  onSplitGroup
}: SortableTabContextMenuProps): React.JSX.Element {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none fixed size-px opacity-0"
          style={{ left: point.x, top: point.y }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-48" sideOffset={0} align="start">
        <DropdownMenuItem onSelect={() => onSplitGroup('up', tab.id)}>
          <Rows2 className="mr-1.5 size-3.5" />
          Split Up
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSplitGroup('down', tab.id)}>
          <Rows2 className="mr-1.5 size-3.5" />
          Split Down
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSplitGroup('left', tab.id)}>
          <Columns2 className="mr-1.5 size-3.5" />
          Split Left
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSplitGroup('right', tab.id)}>
          <Columns2 className="mr-1.5 size-3.5" />
          Split Right
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onTogglePin}>
          {isPinned ? <PinOff className="mr-1.5 size-3.5" /> : <Pin className="mr-1.5 size-3.5" />}
          {isPinned ? 'Unpin Tab' : 'Pin Tab'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => !isPinned && onClose(tab.id)} disabled={isPinned}>
          Close
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onCloseOthers(tab.id)} disabled={tabCount <= 1}>
          Close Others
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onCloseToRight(tab.id)} disabled={!hasTabsToRight}>
          Close Tabs To The Right
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onRenameOpen}>Change Title</DropdownMenuItem>
        <div className="px-2 pt-1.5 pb-1">
          <div className="text-xs font-medium text-muted-foreground mb-1.5">Tab Color</div>
          <div className="flex flex-wrap gap-2">
            {TAB_COLORS.map((color) => {
              const isSelected = tab.color === color.value
              return (
                <DropdownMenuItem
                  key={color.label}
                  className={`relative h-4 w-4 min-w-4 p-0 rounded-full border ${
                    isSelected ? 'ring-1 ring-foreground/70 ring-offset-1 ring-offset-popover' : ''
                  } ${
                    color.value ? 'border-transparent' : 'border-muted-foreground/50 bg-transparent'
                  }`}
                  style={color.value ? { backgroundColor: color.value } : undefined}
                  onSelect={() => {
                    onSetTabColor(tab.id, color.value)
                  }}
                >
                  {color.value === null && (
                    <span className="absolute block h-px w-3 rotate-45 bg-muted-foreground/80" />
                  )}
                </DropdownMenuItem>
              )
            })}
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
