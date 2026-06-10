import { Columns2, Pin, PinOff, Rows2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { TerminalTab } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

const TAB_COLORS = [
  {
    label: translate('auto.components.tab.bar.SortableTabContextMenu.20baa43c05', 'None'),
    value: null
  },
  {
    label: translate('auto.components.tab.bar.SortableTabContextMenu.cb3eadefd2', 'Blue'),
    value: '#3b82f6'
  },
  {
    label: translate('auto.components.tab.bar.SortableTabContextMenu.c2d8b0991f', 'Purple'),
    value: '#a855f7'
  },
  {
    label: translate('auto.components.tab.bar.SortableTabContextMenu.03cf6dab1a', 'Pink'),
    value: '#ec4899'
  },
  {
    label: translate('auto.components.tab.bar.SortableTabContextMenu.620aec6729', 'Red'),
    value: '#ef4444'
  },
  {
    label: translate('auto.components.tab.bar.SortableTabContextMenu.a47629b3cf', 'Orange'),
    value: '#f97316'
  },
  {
    label: translate('auto.components.tab.bar.SortableTabContextMenu.69682e2ce4', 'Yellow'),
    value: '#eab308'
  },
  {
    label: translate('auto.components.tab.bar.SortableTabContextMenu.be905e9b0a', 'Green'),
    value: '#22c55e'
  },
  {
    label: translate('auto.components.tab.bar.SortableTabContextMenu.845576bed1', 'Teal'),
    value: '#14b8a6'
  },
  {
    label: translate('auto.components.tab.bar.SortableTabContextMenu.7703990447', 'Gray'),
    value: '#9ca3af'
  }
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
          {translate('auto.components.tab.bar.SortableTabContextMenu.591f9b12c1', 'Split Up')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSplitGroup('down', tab.id)}>
          <Rows2 className="mr-1.5 size-3.5" />
          {translate('auto.components.tab.bar.SortableTabContextMenu.af80ed83c1', 'Split Down')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSplitGroup('left', tab.id)}>
          <Columns2 className="mr-1.5 size-3.5" />
          {translate('auto.components.tab.bar.SortableTabContextMenu.0ce4bae39d', 'Split Left')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSplitGroup('right', tab.id)}>
          <Columns2 className="mr-1.5 size-3.5" />
          {translate('auto.components.tab.bar.SortableTabContextMenu.21132389e9', 'Split Right')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onTogglePin}>
          {isPinned ? <PinOff className="mr-1.5 size-3.5" /> : <Pin className="mr-1.5 size-3.5" />}
          {isPinned
            ? translate('auto.components.tab.bar.SortableTabContextMenu.417722e9c2', 'Unpin Tab')
            : translate('auto.components.tab.bar.SortableTabContextMenu.60f958ec75', 'Pin Tab')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => !isPinned && onClose(tab.id)} disabled={isPinned}>
          {translate('auto.components.tab.bar.SortableTabContextMenu.89359a36f7', 'Close')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onCloseOthers(tab.id)} disabled={tabCount <= 1}>
          {translate('auto.components.tab.bar.SortableTabContextMenu.8d16f9cd30', 'Close Others')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onCloseToRight(tab.id)} disabled={!hasTabsToRight}>
          {translate(
            'auto.components.tab.bar.SortableTabContextMenu.c1ee099c7e',
            'Close Tabs To The Right'
          )}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onRenameOpen}>
          {translate('auto.components.tab.bar.SortableTabContextMenu.2f697b3c31', 'Change Title')}
        </DropdownMenuItem>
        <div className="px-2 pt-1.5 pb-1">
          <div className="text-xs font-medium text-muted-foreground mb-1.5">
            {translate('auto.components.tab.bar.SortableTabContextMenu.35e8892fd0', 'Tab Color')}
          </div>
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
