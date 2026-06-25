import React from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { translate } from '@/i18n/i18n'
import { TabColorSwatchGrid } from '../tab-bar/tab-color-swatch'
import type { TerminalTab } from '../../../../shared/types'

export type ActivityThreadRowContextMenuProps = {
  children: React.ReactNode
  tab: TerminalTab
  // worktree removed for Commit 1
  unread: boolean
  liveTab: boolean
  // workspaceStatuses removed for Commit 1
  onCloseTab: (tabId: string) => void
  onRenameOpen: () => void
  onSetTabColor: (tabId: string, color: string | null) => void
  onMarkRead: () => void
  onMarkUnread: () => void
}

export function ActivityThreadRowContextMenu({
  children,
  tab,
  // worktree parameter removed for Commit 1
  unread,
  liveTab,
  // workspaceStatuses parameter removed for Commit 1
  onCloseTab,
  onRenameOpen,
  onSetTabColor,
  onMarkRead,
  onMarkUnread
}: ActivityThreadRowContextMenuProps): React.JSX.Element {
  const closeDisabled = !liveTab || tab.isPinned === true

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onSelect={() => onCloseTab(tab.id)} disabled={closeDisabled}>
          {translate('auto.components.tab.bar.SortableTabContextMenu.89359a36f7', 'Close')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onRenameOpen()} disabled={!liveTab}>
          {translate('auto.components.tab.bar.SortableTabContextMenu.2f697b3c31', 'Change Title')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuLabel>
          {translate('auto.components.tab.bar.SortableTabContextMenu.35e8892fd0', 'Tab Color')}
        </ContextMenuLabel>
        <TabColorSwatchGrid
          selectedColor={tab.color}
          className="px-2 pt-1 pb-1.5"
          renderSwatch={({ color, className, style, ariaLabel, children }) => (
            <ContextMenuItem
              key={color.label}
              disabled={!liveTab}
              aria-label={ariaLabel}
              className={className}
              style={style}
              onSelect={() => onSetTabColor(tab.id, color.value)}
            >
              {children}
            </ContextMenuItem>
          )}
        />
        <ContextMenuSeparator />
        {unread ? (
          <ContextMenuItem onSelect={() => onMarkRead()}>
            {translate('auto.components.sidebar.WorktreeContextMenu.8dacff1fe0', 'Mark Read')}
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={() => onMarkUnread()}>
            {translate('auto.components.sidebar.WorktreeContextMenu.f50603c6b2', 'Mark Unread')}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
