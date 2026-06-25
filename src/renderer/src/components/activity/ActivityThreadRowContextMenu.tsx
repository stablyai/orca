import React from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { TabColorSwatchGrid } from '../tab-bar/tab-color-swatch'
import { getWorkspaceStatusVisualMeta } from '../sidebar/workspace-status'
import type {
  TerminalTab,
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../shared/types'

export type ActivityThreadRowContextMenuProps = {
  children: React.ReactNode
  tab: TerminalTab
  worktree: Worktree
  unread: boolean
  liveTab: boolean
  canMoveWorkspaceStatus: boolean
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  currentWorkspaceStatus: WorkspaceStatus | ''
  onCloseTab: (tabId: string) => void
  onRenameOpen: () => void
  onSetTabColor: (tabId: string, color: string | null) => void
  onMoveToStatus: (worktreeId: string, status: WorkspaceStatus) => void
  onMarkRead: () => void
  onMarkUnread: () => void
}

export function ActivityThreadRowContextMenu({
  children,
  tab,
  worktree,
  unread,
  liveTab,
  canMoveWorkspaceStatus,
  workspaceStatuses,
  currentWorkspaceStatus,
  onCloseTab,
  onRenameOpen,
  onSetTabColor,
  onMoveToStatus,
  onMarkRead,
  onMarkUnread
}: ActivityThreadRowContextMenuProps): React.JSX.Element {
  const closeDisabled = !liveTab || tab.isPinned === true
  const statusDisabled = !canMoveWorkspaceStatus || workspaceStatuses.length === 0

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
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={statusDisabled}>
            {translate('auto.components.sidebar.WorktreeContextMenu.84cdbb7e30', 'Move to Status')}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-44">
            <ContextMenuRadioGroup value={currentWorkspaceStatus}>
              {workspaceStatuses.map((status) => {
                const meta = getWorkspaceStatusVisualMeta(status)
                return (
                  <ContextMenuRadioItem
                    key={status.id}
                    value={status.id}
                    onSelect={() => onMoveToStatus(worktree.id, status.id)}
                  >
                    <meta.icon className={cn('size-3.5', meta.tone)} />
                    {status.label}
                  </ContextMenuRadioItem>
                )
              })}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
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
