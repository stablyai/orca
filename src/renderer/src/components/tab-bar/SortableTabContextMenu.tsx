import { Pencil, Pin, PinOff, SquareTerminal, Timer, X } from 'lucide-react'
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuContent
} from '@/components/ui/context-menu'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { useAppStore } from '../../store'
import { formatShortcutLabel, useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { TerminalTabSplitMenuSection } from './TerminalTabSplitMenuSection'
import { TabSessionSurfaceSwitchMenuItems } from './TabSessionSurfaceSwitchMenuItems'
import type { NativeChatTabSession } from './tab-session-history-switch'
import { CopyTabIdMenuItem } from './CopyTabIdMenuItem'
import { useAllowAutoClose } from './use-allow-auto-close'
import { CloseSplitPaneMenuItem } from './CloseSplitPaneMenuItem'

const TAB_COLORS = [
  {
    get label() {
      return translate('auto.components.tab.bar.SortableTabContextMenu.20baa43c05', 'None')
    },
    value: null
  },
  {
    get label() {
      return translate('auto.components.tab.bar.SortableTabContextMenu.cb3eadefd2', 'Blue')
    },
    value: '#3b82f6'
  },
  {
    get label() {
      return translate('auto.components.tab.bar.SortableTabContextMenu.c2d8b0991f', 'Purple')
    },
    value: '#a855f7'
  },
  {
    get label() {
      return translate('auto.components.tab.bar.SortableTabContextMenu.03cf6dab1a', 'Pink')
    },
    value: '#ec4899'
  },
  {
    get label() {
      return translate('auto.components.tab.bar.SortableTabContextMenu.620aec6729', 'Red')
    },
    value: '#ef4444'
  },
  {
    get label() {
      return translate('auto.components.tab.bar.SortableTabContextMenu.a47629b3cf', 'Orange')
    },
    value: '#f97316'
  },
  {
    get label() {
      return translate('auto.components.tab.bar.SortableTabContextMenu.69682e2ce4', 'Yellow')
    },
    value: '#eab308'
  },
  {
    get label() {
      return translate('auto.components.tab.bar.SortableTabContextMenu.be905e9b0a', 'Green')
    },
    value: '#22c55e'
  },
  {
    get label() {
      return translate('auto.components.tab.bar.SortableTabContextMenu.845576bed1', 'Teal')
    },
    value: '#14b8a6'
  },
  {
    get label() {
      return translate('auto.components.tab.bar.SortableTabContextMenu.7703990447', 'Gray')
    },
    value: '#9ca3af'
  }
] as const

type SortableTabContextMenuProps = {
  tab: Pick<TerminalTab, 'id' | 'worktreeId' | 'color'>
  unifiedTabId: string
  groupId: string
  isActive: boolean
  open: boolean
  tabCount: number
  hasTabsToRight: boolean
  hasTabsToLeft: boolean
  isPinned: boolean
  onSessionSwitchComplete?: () => void
  sessionSwitchOpening?: number | null
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseToRight: (tabId: string) => void
  onCloseToLeft: (tabId: string) => void
  onCloseSplitPane?: () => void
  onRenameOpen: () => void
  onSetTabColor: (tabId: string, color: string | null) => void
  onTogglePin: () => void
  /** Only terminal-backed agent tabs can switch view; structured chats have no terminal beneath them. */
  canToggleViewMode?: boolean
  /** Select the destination label/icon from the tab’s current chat/terminal view. */
  isChatView?: boolean
  onToggleViewMode?: () => void
  canSplitTerminal?: boolean
  nativeChat?: NativeChatTabSession
}

export function SortableTabContextMenu({
  tab,
  unifiedTabId,
  groupId,
  isActive,
  open,
  tabCount,
  isPinned,
  onSessionSwitchComplete,
  sessionSwitchOpening,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseSplitPane,
  onRenameOpen,
  onSetTabColor,
  onTogglePin,
  canToggleViewMode = false,
  isChatView = false,
  onToggleViewMode,
  canSplitTerminal = true,
  nativeChat
}: SortableTabContextMenuProps): React.JSX.Element {
  const keybindings = useAppStore((state) => state.keybindings)
  const splitRightShortcut = formatShortcutLabel('terminal.splitRight', keybindings)
  const splitDownShortcut = formatShortcutLabel('terminal.splitDown', keybindings)

  const closeShortcut = useOptionalShortcutLabel('tab.close')
  const renameShortcut = useOptionalShortcutLabel('tab.rename')
  // Keep the route back from chat even while switching terminals into chat is disabled.
  const showTerminalViewSwitch = canToggleViewMode && isChatView && onToggleViewMode !== undefined

  // Shown only on an orchestration worker the user kept open; returns it to auto-close.
  const onAllowAutoClose = useAllowAutoClose({
    open,
    tabId: tab.id,
    worktreeId: tab.worktreeId,
    sessionId: nativeChat?.sessionId
  })

  return (
    <ContextMenuContent
      animation="none"
      className="min-w-[13rem] max-w-[calc(100vw-1rem)] whitespace-nowrap"
    >
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
      {showTerminalViewSwitch ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onToggleViewMode}>
            <SquareTerminal className="size-3.5 shrink-0" />
            {translate(
              'components.tab.bar.SortableTabContextMenu.switchToTerminalView',
              'Continue with Terminal Agent'
            )}
          </ContextMenuItem>
        </>
      ) : null}
      <TabSessionSurfaceSwitchMenuItems
        key={sessionSwitchOpening}
        tab={tab}
        nativeChat={nativeChat}
        leadingSeparator={!showTerminalViewSwitch}
        onComplete={onSessionSwitchComplete}
      />
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={onTogglePin}>
        {isPinned ? (
          <PinOff className="size-3.5 shrink-0" />
        ) : (
          <Pin className="size-3.5 shrink-0" />
        )}
        {isPinned
          ? translate('auto.components.tab.bar.SortableTabContextMenu.417722e9c2', 'Unpin Tab')
          : translate('auto.components.tab.bar.SortableTabContextMenu.60f958ec75', 'Pin Tab')}
      </ContextMenuItem>
      {onAllowAutoClose ? (
        <ContextMenuItem onSelect={onAllowAutoClose}>
          <Timer className="size-3.5 shrink-0" />
          {translate(
            'components.tab.bar.SortableTabContextMenu.allowAutoClose',
            'Allow Auto-Close'
          )}
        </ContextMenuItem>
      ) : null}
      <CopyTabIdMenuItem menuKind="context" unifiedTabId={unifiedTabId} />
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => !isPinned && onClose(tab.id)} disabled={isPinned}>
        <X className="size-3.5" />
        {translate('auto.components.tab.bar.SortableTabContextMenu.89359a36f7', 'Close')}
        {closeShortcut ? <ContextMenuShortcut>{closeShortcut}</ContextMenuShortcut> : null}
      </ContextMenuItem>
      <ContextMenuItem inset onSelect={() => onCloseOthers(tab.id)} disabled={tabCount <= 1}>
        {translate('auto.components.tab.bar.SortableTabContextMenu.8d16f9cd30', 'Close Others')}
      </ContextMenuItem>
      <CloseSplitPaneMenuItem menuKind="context" onCloseSplitPane={onCloseSplitPane} />
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={onRenameOpen}>
        <Pencil className="size-3.5" />
        {translate('auto.components.tab.bar.SortableTabContextMenu.2f697b3c31', 'Change Title')}
        {renameShortcut ? <ContextMenuShortcut>{renameShortcut}</ContextMenuShortcut> : null}
      </ContextMenuItem>
      <div className="pt-1.5 pr-2.5 pb-1.5 pl-8">
        <div className="text-2xs font-semibold text-muted-foreground mb-1.5">
          {translate('auto.components.tab.bar.SortableTabContextMenu.35e8892fd0', 'Tab Color')}
        </div>
        <div className="flex flex-wrap gap-2">
          {TAB_COLORS.map((color) => {
            const isSelected = tab.color === color.value
            return (
              <ContextMenuItem
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
              </ContextMenuItem>
            )
          })}
        </div>
      </div>
    </ContextMenuContent>
  )
}
