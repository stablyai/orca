import React from 'react'
import { Bell, BellOff, Copy, ExternalLink, PanelRight, X } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { translate } from '@/i18n/i18n'
import { clearActivityThread, isClearableActivityThread } from './activity-clear-completed'
import { activityThreadRowCopy } from './activity-thread-presentation'
import type { AgentPaneThread } from './activity-thread-types'

type CopyTarget = { key: string; label: string; value: string }

export function getActivityThreadCopyTargets(
  thread: AgentPaneThread,
  hasWorkspace: boolean
): CopyTarget[] {
  const title: CopyTarget = {
    key: 'title',
    label: translate('auto.components.activity.ActivityThreadContextMenu.copyTitle', 'Copy Title'),
    value: activityThreadRowCopy(thread).taskTitle
  }
  // Why gated: synthetic floating/standalone worktrees have no path.
  if (!hasWorkspace || !thread.worktree.path) {
    return [title]
  }
  const path: CopyTarget = {
    key: 'path',
    label: translate('auto.components.activity.ActivityThreadContextMenu.copyPath', 'Copy Path'),
    value: thread.worktree.path
  }
  // Same order as the workspace menu: Copy Path, then the name.
  return [path, title]
}

/** Right-click actions for an activity row; mirrors the row's own click and hover actions. */
export function ActivityThreadContextMenu({
  thread,
  canJump,
  disableMarkUnread,
  onOpen,
  onJump,
  onMarkRead,
  onMarkUnread,
  children
}: {
  thread: AgentPaneThread
  canJump: boolean
  disableMarkUnread: boolean
  onOpen: (thread: AgentPaneThread) => void
  onJump: (thread: AgentPaneThread) => void
  onMarkRead: (thread: AgentPaneThread) => void
  onMarkUnread: (thread: AgentPaneThread) => void
  /** Receives whether the menu is open, so the row can keep its preview out of the way. */
  children: (menuOpen: boolean) => React.ReactElement
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = React.useState(false)
  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger asChild>{children(menuOpen)}</ContextMenuTrigger>
      {/* Why no focus restore: refocusing the row would reopen its hover preview and pin it open. */}
      <ContextMenuContent className="w-52" onCloseAutoFocus={(event) => event.preventDefault()}>
        <ContextMenuLabel>
          {translate('auto.components.activity.ActivityThreadContextMenu.agentSection', 'Agent')}
        </ContextMenuLabel>
        <ContextMenuItem onSelect={() => onOpen(thread)}>
          <PanelRight className="size-3.5" />
          {translate('auto.components.activity.ActivityThreadContextMenu.open', 'Open')}
        </ContextMenuItem>
        {canJump ? (
          <ContextMenuItem onSelect={() => onJump(thread)}>
            <ExternalLink className="size-3.5" />
            {translate(
              'auto.components.activity.ActivityThreadContextMenu.goToWorkspace',
              'Go to Workspace'
            )}
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        {getActivityThreadCopyTargets(thread, canJump).map((target) => (
          <ContextMenuItem
            key={target.key}
            onSelect={() => void window.api.ui.writeClipboardText(target.value)}
          >
            <Copy className="size-3.5" />
            {target.label}
          </ContextMenuItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={!thread.unread && disableMarkUnread}
          onSelect={() => (thread.unread ? onMarkRead(thread) : onMarkUnread(thread))}
        >
          {thread.unread ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />}
          {thread.unread
            ? translate('auto.components.activity.ActivityThreadContextMenu.markRead', 'Mark Read')
            : translate(
                'auto.components.activity.ActivityThreadContextMenu.markUnread',
                'Mark Unread'
              )}
        </ContextMenuItem>
        {isClearableActivityThread(thread) ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => clearActivityThread(thread)}>
              <X className="size-3.5" />
              {translate(
                'auto.components.activity.ActivityThreadContextMenu.clear',
                'Clear from List'
              )}
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}
