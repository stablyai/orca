import {
  MessageSquare,
  PanelLeftClose,
  PanelRightClose,
  Pin,
  PinOff,
  Pencil,
  SquareTerminal,
  X,
  ListX
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { useAppStore } from '../../store'
import { formatShortcutLabel, useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { TerminalTabSplitMenuSection } from './TerminalTabSplitMenuSection'
import { TAB_CONTEXT_MENU_CONTENT_CLASS } from './tab-context-menu-sizing'
import { PRESET_TAB_COLORS } from './tab-colors'

type SortableTabContextMenuProps = {
  tab: TerminalTab
  unifiedTabId: string
  groupId: string
  isActive: boolean
  open: boolean
  point: { x: number; y: number }
  tabCount: number
  hasTabsToRight: boolean
  hasTabsToLeft: boolean
  isPinned: boolean
  onOpenChange: (open: boolean) => void
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseToRight: (tabId: string) => void
  onCloseToLeft: (tabId: string) => void
  onRenameOpen: () => void
  onSetTabColor: (tabId: string, color: string | null) => void
  onTogglePin: () => void
  /** True when this tab is an agent terminal that can switch between the terminal
   *  and native chat views; gates the "Switch view" menu item. Structured
   *  sessions never qualify — they have no terminal underneath. */
  canToggleViewMode?: boolean
  /** True when the tab is currently showing the native chat view (drives the
   *  item's label/icon between "chat" and "terminal"). */
  isChatView?: boolean
  /** Toggle the tab between terminal and native chat view. */
  onToggleViewMode?: () => void
  canSplitTerminal?: boolean
}

export function SortableTabContextMenu({
  tab,
  unifiedTabId,
  groupId,
  isActive,
  open,
  point,
  tabCount,
  hasTabsToRight,
  hasTabsToLeft,
  isPinned,
  onOpenChange,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseToLeft,
  onRenameOpen,
  onSetTabColor,
  onTogglePin,
  canToggleViewMode = false,
  isChatView = false,
  onToggleViewMode,
  canSplitTerminal = true
}: SortableTabContextMenuProps): React.JSX.Element {
  const keybindings = useAppStore((state) => state.keybindings)
  const splitRightShortcut = formatShortcutLabel('terminal.splitRight', keybindings)
  const splitDownShortcut = formatShortcutLabel('terminal.splitDown', keybindings)

  const closeShortcut = useOptionalShortcutLabel('tab.close')
  const renameShortcut = useOptionalShortcutLabel('tab.rename')

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
      {open ? (
        <DropdownMenuContent className={TAB_CONTEXT_MENU_CONTENT_CLASS} sideOffset={0} align="start">
        <TerminalTabSplitMenuSection
          unifiedTabId={unifiedTabId}
          groupId={groupId}
          tabId={tab.id}
          isActive={isActive}
          onActivate={onActivate}
          splitRightShortcut={splitRightShortcut}
          splitDownShortcut={splitDownShortcut}
          showTerminalSplit={canSplitTerminal}
        />
        {canToggleViewMode && onToggleViewMode ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onToggleViewMode}>
              {isChatView ? (
                <SquareTerminal className="size-3.5 shrink-0" />
              ) : (
                <MessageSquare className="size-3.5 shrink-0" />
              )}
              {isChatView
                ? translate(
                    'components.tab.bar.SortableTabContextMenu.switchToTerminalView',
                    'Switch to terminal view'
                  )
                : translate(
                    'components.tab.bar.SortableTabContextMenu.switchToChatView',
                    'Switch to chat view'
                  )}
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onTogglePin}>
          {isPinned ? (
            <PinOff className="size-3.5 shrink-0" />
          ) : (
            <Pin className="size-3.5 shrink-0" />
          )}
          {isPinned
            ? translate('auto.components.tab.bar.SortableTabContextMenu.417722e9c2', 'Unpin Tab')
            : translate('auto.components.tab.bar.SortableTabContextMenu.60f958ec75', 'Pin Tab')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => !isPinned && onClose(tab.id)} disabled={isPinned}>
          <X className="size-3.5" />
          {translate('auto.components.tab.bar.SortableTabContextMenu.89359a36f7', 'Close')}
          {closeShortcut ? <DropdownMenuShortcut>{closeShortcut}</DropdownMenuShortcut> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onCloseOthers(tab.id)} disabled={tabCount <= 1}>
          <ListX className="size-3.5" />
          {translate('auto.components.tab.bar.SortableTabContextMenu.8d16f9cd30', 'Close Others')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onCloseToRight(tab.id)} disabled={!hasTabsToRight}>
          <PanelRightClose className="size-3.5" />
          {translate(
            'auto.components.tab.bar.SortableTabContextMenu.c1ee099c7e',
            'Close Tabs To The Right'
          )}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onCloseToLeft(tab.id)} disabled={!hasTabsToLeft}>
          <PanelLeftClose className="size-3.5" />
          {translate(
            'components.tab.bar.SortableTabContextMenu.closeTabsToLeft',
            'Close Tabs To The Left'
          )}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onRenameOpen}>
          <Pencil className="size-3.5" />
          {translate('auto.components.tab.bar.SortableTabContextMenu.2f697b3c31', 'Change Title')}
          {renameShortcut ? <DropdownMenuShortcut>{renameShortcut}</DropdownMenuShortcut> : null}
        </DropdownMenuItem>
        <div className="px-2 pt-1.5 pb-1">
          <div className="flex items-center justify-between text-xs font-medium text-muted-foreground mb-1.5">
            <span>
              {translate('auto.components.tab.bar.SortableTabContextMenu.35e8892fd0', 'Frame Color')}
            </span>
            <label
              className="relative flex h-4 w-4 cursor-pointer items-center justify-center rounded-full border border-dashed border-muted-foreground/60 hover:border-foreground overflow-hidden"
              title="自訂色彩 (Custom Color)"
            >
              <span className="text-[9px] font-mono leading-none select-none text-muted-foreground">+</span>
              <input
                type="color"
                className="absolute inset-0 opacity-0 cursor-pointer"
                value={tab.color ?? '#3b82f6'}
                onChange={(e) => {
                  onSetTabColor(tab.id, e.target.value)
                  onOpenChange(false)
                }}
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            {PRESET_TAB_COLORS.map((color) => {
              const isSelected = tab.color === color.value
              return (
                <DropdownMenuItem
                  key={color.label}
                  className={`relative h-4 w-4 min-w-4 p-0 rounded-full border cursor-pointer ${
                    isSelected ? 'ring-1 ring-foreground/70 ring-offset-1 ring-offset-popover' : ''
                  } ${
                    color.value ? 'border-transparent' : 'border-muted-foreground/50 bg-transparent'
                  }`}
                  style={color.value ? { backgroundColor: color.value } : undefined}
                  onSelect={() => {
                    onSetTabColor(tab.id, color.value)
                  }}
                  title={color.label}
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
      ) : null}
    </DropdownMenu>
  )
}
