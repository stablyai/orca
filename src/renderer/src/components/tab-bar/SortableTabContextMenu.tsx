import {
  MessageSquare,
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
import type { TerminalTab } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { formatShortcutLabel, useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { TerminalTabSplitMenuSection } from './TerminalTabSplitMenuSection'
import { TabColorSwatchGrid } from './tab-color-swatch'

type SortableTabContextMenuProps = {
  tab: TerminalTab
  unifiedTabId: string
  groupId: string
  isActive: boolean
  open: boolean
  point: { x: number; y: number }
  tabCount: number
  hasTabsToRight: boolean
  isPinned: boolean
  onOpenChange: (open: boolean) => void
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseToRight: (tabId: string) => void
  onRenameOpen: () => void
  onSetTabColor: (tabId: string, color: string | null) => void
  onTogglePin: () => void
  /** True when this tab is an agent terminal that can switch to the native chat
   *  view; gates the "Switch view" menu item. */
  canToggleViewMode?: boolean
  /** True when the tab is currently showing the native chat view (drives the
   *  item's label/icon between "chat" and "terminal"). */
  isChatView?: boolean
  /** Toggle the tab between terminal and native chat view. */
  onToggleViewMode?: () => void
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
  isPinned,
  onOpenChange,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onRenameOpen,
  onSetTabColor,
  onTogglePin,
  canToggleViewMode = false,
  isChatView = false,
  onToggleViewMode
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
      <DropdownMenuContent className="w-56" sideOffset={0} align="start">
        <TerminalTabSplitMenuSection
          unifiedTabId={unifiedTabId}
          groupId={groupId}
          tabId={tab.id}
          isActive={isActive}
          onActivate={onActivate}
          splitRightShortcut={splitRightShortcut}
          splitDownShortcut={splitDownShortcut}
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
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onRenameOpen}>
          <Pencil className="size-3.5" />
          {translate('auto.components.tab.bar.SortableTabContextMenu.2f697b3c31', 'Change Title')}
          {renameShortcut ? <DropdownMenuShortcut>{renameShortcut}</DropdownMenuShortcut> : null}
        </DropdownMenuItem>
        <div className="px-2 pt-1.5 pb-1">
          <div className="text-xs font-medium text-muted-foreground mb-1.5">
            {translate('auto.components.tab.bar.SortableTabContextMenu.35e8892fd0', 'Tab Color')}
          </div>
          <TabColorSwatchGrid
            selectedColor={tab.color}
            renderSwatch={({ color, className, style, ariaLabel, children }) => (
              <DropdownMenuItem
                key={color.label}
                className={className}
                style={style}
                aria-label={ariaLabel}
                onSelect={() => {
                  onSetTabColor(tab.id, color.value)
                }}
              >
                {children}
              </DropdownMenuItem>
            )}
          />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
