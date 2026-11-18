// A bot picture's corner badge, drawn the same in both card styles: worktree cards size theirs per style.
import type React from 'react'
import { Moon } from 'lucide-react'
import StatusIndicator from '@/components/sidebar/workspace-card/surface/StatusIndicator'
import { selectIsSleepingWorktree } from '@/components/sidebar/workspace-actions/sleep/use-worktree-sleep-state'
import { useTranslate } from '@/i18n/use-translate'
import { getWorktreeStatusLabel } from '@/lib/workspace/activity/worktree-status'
import { useAppStore } from '@/store'
import type { WorktreeStatus } from '../../../../shared/worktree/row-display/worktree-status-rollup'

// StatusIndicator draws these as 12px icons; every other status is an 8px dot or spinner.
const ICON_STATUSES = new Set<WorktreeStatus | null>(['monitoring', 'permission', 'unconfirmed'])
// The quiet statuses a sleeping home shows as a moon.
const QUIET_STATUSES = new Set<WorktreeStatus | null>(['active', 'done', 'inactive'])

// The unread dot's 1.5px gap, bitten from the glyph under it rather than painted, so any row background shows.
const UNREAD_BITE: React.CSSProperties = {
  maskImage: 'radial-gradient(circle at 11px 11px, transparent 4.5px, #000 5px)'
}

export type BotAvatarBadgeState = {
  status: WorktreeStatus | null
  isUnread: boolean
  sleeping: boolean
}

/** Whether the home sleeps while its status is quiet, so its badge is the moon. */
export function useBotAvatarBadgeSleeping(
  workspaceId: string,
  status: WorktreeStatus | null
): boolean {
  return useAppStore((s) => QUIET_STATUSES.has(status) && selectIsSleepingWorktree(s, workspaceId))
}

/** A 2px gap around the badge, cut from the picture so the row's own background (hover and
 *  selection included) shows through instead of a painted disc. */
export function botAvatarBadgeCutout({
  status,
  isUnread,
  sleeping
}: BotAvatarBadgeState): React.CSSProperties | undefined {
  if (status === null && !isUnread) {
    return undefined
  }
  const radius = ICON_STATUSES.has(status) || (sleeping && QUIET_STATUSES.has(status)) ? 8 : 6
  return {
    maskImage: `radial-gradient(circle at calc(100% - 3px) calc(100% - 3px), transparent ${radius}px, #000 ${radius + 0.5}px)`
  }
}

/** The badge, centred 3px in from the picture's bottom-right corner; pair it with the cutout. */
export function BotAvatarStatusBadge({
  status,
  isUnread,
  sleeping
}: BotAvatarBadgeState): React.JSX.Element {
  const t = useTranslate()
  const anchor = 'absolute right-[3px] bottom-[3px] flex size-0 items-center justify-center'
  if (status === null && !isUnread) {
    return <span data-worktree-card-status-slot="" className={anchor} />
  }
  const statusLabel = status === null ? null : getWorktreeStatusLabel(status) || status
  const label =
    statusLabel && isUnread
      ? t('workspace.activity.unreadLabel', '{{status}} · Unread', { status: statusLabel })
      : (statusLabel ?? t('bots.chats.unread', 'Unread'))
  const glyph =
    status === null ? (
      <span data-bot-unread-dot="" className="block size-2 rounded-full bg-unread" />
    ) : sleeping && QUIET_STATUSES.has(status) ? (
      <Moon className="size-3 text-muted-foreground" />
    ) : (
      <StatusIndicator status={status} showTooltip={false} />
    )
  const showUnreadDot = isUnread && status !== null
  return (
    <span data-worktree-card-status-slot="" className={anchor}>
      <span className="relative flex size-3 shrink-0 items-center justify-center" aria-hidden>
        <span
          className="flex size-3 items-center justify-center"
          style={showUnreadDot ? UNREAD_BITE : undefined}
        >
          {glyph}
        </span>
        {showUnreadDot ? (
          <span
            data-bot-unread-dot=""
            className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-unread"
          />
        ) : null}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  )
}
