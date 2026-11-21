import React, { useState } from 'react'
import { Bell, BellOff, Pencil } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { HoverCardContent } from '@/components/ui/hover-card'
import { ActivityThreadHoverCardRoot } from '@/components/activity/thread-preview/activity-thread-hover-card-root'
import { WORKTREE_CARD_SURFACE_CLASS_NAME } from '@/components/sidebar/workspace-card/surface/worktree-card-surface'
import { WorktreeTitleInlineRename } from '@/components/sidebar/workspace-card/identity/WorktreeTitleInlineRename'
import type { WorktreeStatus } from '../../../../shared/worktree/row-display/worktree-status-rollup'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store'
import StatusIndicator from '@/components/sidebar/workspace-card/surface/StatusIndicator'
import { getWorktreeStatusLabel } from '@/lib/workspace/activity/worktree-status'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import {
  BotAvatarStatusBadge,
  botAvatarBadgeCutout,
  useBotAvatarBadgeSleeping
} from './bot-avatar-status-badge'

/** One row of the Bots section, a bot's or a group's: picture, name and time, then its newest line. */
export type BotSidebarRowProps = {
  /** The row's picture: a bot's avatar, or a group's member faces. */
  avatar: React.ReactNode
  name: string
  /** Its home's key: the status and unread mark are the home's. */
  workspaceId: string
  hostId: ExecutionHostId
  /** The avatar shows exceptions and the row's end shows working; healthy states stay unmarked. */
  status: WorktreeStatus | null
  /** Its chat, worker or run stopped on a usage limit while the row is quiet: the corner's tooltip. */
  stopTip?: string | null
  isUnread: boolean
  isActive: boolean
  dimmed?: boolean
  /** Its host is disconnected: Rename and Mark Read/Unread are off, as the caller's items are. */
  actionsDisabled?: boolean
  /** The Bots section's reorder: this row is where a drag starts. */
  dragHandle?: boolean
  /** Set for a row that folds: whether it is unfolded. */
  expanded?: boolean
  onOpen: (event: { detail: number; target: EventTarget; repeat?: boolean }) => void
  onRename: (name: string) => Promise<void>
  /** How long ago its newest line happened. */
  age: string | null
  /** The second line, under the name. */
  line: React.ReactNode
  /** A column after both lines at the row's right edge, such as the fold toggle's strip. Given one,
   *  it shows the row's working state; otherwise the row's end shows it. */
  trailing?: React.ReactNode
  /** What the hover card shows, rendered only while it is open. */
  hoverDetails: () => React.ReactNode
  /** Rename and Mark Read/Unread lead the menu; these follow. */
  menuItems: React.ReactNode
  menuFooter: React.ReactNode
}

export function BotSidebarRow({
  avatar,
  name,
  workspaceId,
  hostId,
  status,
  stopTip = null,
  isUnread,
  isActive,
  expanded,
  dimmed = false,
  actionsDisabled = false,
  dragHandle = false,
  onOpen,
  onRename,
  age,
  line,
  trailing = null,
  hoverDetails,
  menuItems,
  menuFooter
}: BotSidebarRowProps): React.JSX.Element {
  const t = useTranslate()
  const setWorkspaceUnreadByUser = useAppStore((s) => s.setWorkspaceUnreadByUser)
  const [renameRequested, setRenameRequested] = useState(false)
  const [hoverOpen, setHoverOpen] = useState(false)
  const toggleUnread = (): void => setWorkspaceUnreadByUser(workspaceId, !isUnread, hostId)
  // Working shows once, at the row's end, where every working row shows it.
  const badgeStatus = status === 'working' ? null : status
  const badge = {
    status: badgeStatus,
    sleeping: useBotAvatarBadgeSleeping(workspaceId, badgeStatus),
    stopTip
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-worktree-card-surface="true"
          data-worktree-card-active={isActive ? 'primary' : undefined}
          aria-expanded={expanded}
          data-project-group-header-drag-handle={dragHandle ? '' : undefined}
          className={cn(
            WORKTREE_CARD_SURFACE_CLASS_NAME,
            // A two-line workspace card's padding, so bots sit as tight as Projects' rows.
            // A size container: the fold strip slims down in a narrow sidebar.
            'group/bot-row @container/bot-row flex items-center pt-1.25 pb-1.25 pl-1.25',
            !isActive && 'worktree-sidebar-card-hover',
            dimmed && 'opacity-60'
          )}
          onClick={onOpen}
          onContextMenu={() => setHoverOpen(false)}
          // The title is the row's focus stop; its rename input keeps its own keys.
          onKeyDown={(event) => {
            // The unread bell is a button of its own.
            if (event.target instanceof Element && event.target.closest('button')) {
              return
            }
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onOpen(event)
            }
          }}
        >
          {/* Exceptions sit on the picture's corner, the same in both card styles. */}
          <span className="relative mr-2 shrink-0">
            <span className="flex" style={botAvatarBadgeCutout(badge)}>
              {avatar}
            </span>
            <BotAvatarStatusBadge {...badge} />
          </span>
          {/* Opens on pointer rest like Activity's cards, so sweeping across rows doesn't flash them.
              The trigger runs to the row's end, fold toggle included, so the card always opens past
              the sidebar's edge as a workspace row's does. */}
          <ActivityThreadHoverCardRoot
            open={hoverOpen}
            onOpenChange={setHoverOpen}
            closeDelay={120}
            trigger={
              <div className="flex min-w-0 flex-1 gap-1 self-stretch">
                <div className="flex min-w-0 flex-1 flex-col justify-center">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <WorktreeTitleInlineRename
                      displayName={name}
                      showUnreadEmphasis={isUnread}
                      dimReadTitle
                      className="text-[13px] leading-5"
                      editingClassName="flex-1"
                      onRename={onRename}
                      // The hover card already shows the full name.
                      titleWrapper={(title) => title}
                      beginEditing={renameRequested}
                      onBeginEditingConsumed={() => setRenameRequested(false)}
                    />
                    {age ? (
                      <span className="ml-auto shrink-0 text-xs leading-4 text-muted-foreground tabular-nums">
                        {age}
                      </span>
                    ) : null}
                  </div>
                  {line}
                </div>
                {trailing ?? (status === 'working' ? <BotRowWorkingMark /> : null)}
              </div>
            }
          >
            <HoverCardContent
              side="right"
              align="start"
              sideOffset={8}
              variant="workspace-details"
              // Portal clicks still bubble to the row through React.
              onClick={(event) => event.stopPropagation()}
            >
              {hoverOpen ? hoverDetails() : null}
            </HoverCardContent>
          </ActivityThreadHoverCardRoot>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem disabled={actionsDisabled} onSelect={() => setRenameRequested(true)}>
          <Pencil className="size-3.5" />
          {t('bots.row.rename', 'Rename')}
        </ContextMenuItem>
        {menuItems}
        <ContextMenuItem disabled={actionsDisabled} onSelect={toggleUnread}>
          {isUnread ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />}
          {isUnread ? t('bots.row.markRead', 'Mark Read') : t('bots.row.markUnread', 'Mark Unread')}
        </ContextMenuItem>
        {menuFooter}
      </ContextMenuContent>
    </ContextMenu>
  )
}

function BotRowWorkingMark(): React.JSX.Element {
  const label = getWorktreeStatusLabel('working')
  return (
    <span role="img" aria-label={label} className="flex shrink-0 items-center px-1">
      <StatusIndicator status="working" showTooltip={false} aria-hidden />
    </span>
  )
}
