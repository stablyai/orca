// A bot picture's corner badge, drawn the same in both card styles: worktree cards size theirs per style.
import type React from 'react'
import { Gauge, Moon } from 'lucide-react'
import { StateIndicatorTooltip } from '@/components/agent/status/StateIndicatorTooltip'
import StatusIndicator from '@/components/sidebar/workspace-card/surface/StatusIndicator'
import { selectIsSleepingWorktree } from '@/components/sidebar/workspace-actions/sleep/use-worktree-sleep-state'
import { getWorktreeStatusLabel } from '@/lib/workspace/activity/worktree-status'
import { useAppStore } from '@/store'
import type { WorktreeStatus } from '../../../../shared/worktree/row-display/worktree-status-rollup'

// StatusIndicator draws these as 12px icons; every other status is an 8px dot or spinner.
const ICON_STATUSES = new Set<WorktreeStatus | null>(['monitoring', 'permission', 'unconfirmed'])
// The quiet statuses a sleeping home shows as a moon.
const QUIET_STATUSES = new Set<WorktreeStatus | null>(['active', 'done', 'inactive'])

export type BotAvatarBadgeState = {
  status: WorktreeStatus | null
  sleeping: boolean
  /** Stopped on a usage limit while quiet: the usage-limit gauge, with this as its tooltip. */
  stopTip?: string | null
}

/** Whether the home sleeps while its status is quiet, so its badge is the moon. */
export function useBotAvatarBadgeSleeping(
  workspaceId: string,
  status: WorktreeStatus | null
): boolean {
  return useAppStore((s) => QUIET_STATUSES.has(status) && selectIsSleepingWorktree(s, workspaceId))
}

function hasAvatarStatusBadge({ status, sleeping, stopTip }: BotAvatarBadgeState): boolean {
  return (
    Boolean(stopTip) ||
    (status !== null && (sleeping || (status !== 'active' && status !== 'done')))
  )
}

/** A 2px gap around the badge, cut from the picture so the row's own background (hover and
 *  selection included) shows through instead of a painted disc. */
export function botAvatarBadgeCutout({
  status,
  sleeping,
  stopTip = null
}: BotAvatarBadgeState): React.CSSProperties | undefined {
  if (!hasAvatarStatusBadge({ status, sleeping, stopTip })) {
    return undefined
  }
  const radius =
    stopTip || ICON_STATUSES.has(status) || (sleeping && QUIET_STATUSES.has(status)) ? 8 : 6
  return {
    maskImage: `radial-gradient(circle at calc(100% - 3px) calc(100% - 3px), transparent ${radius}px, #000 ${radius + 0.5}px)`
  }
}

/** The badge, centred 3px in from the picture's bottom-right corner; pair it with the cutout. */
export function BotAvatarStatusBadge({
  status,
  sleeping,
  stopTip = null
}: BotAvatarBadgeState): React.JSX.Element | null {
  const anchor = 'absolute right-[3px] bottom-[3px] flex size-0 items-center justify-center'
  if (stopTip) {
    return (
      <span data-worktree-card-status-slot="" className={anchor}>
        <StateIndicatorTooltip label={stopTip}>
          <span
            role="img"
            aria-label={stopTip}
            className="flex size-3 shrink-0 items-center justify-center"
          >
            <Gauge className="size-3 text-status-warning" aria-hidden />
          </span>
        </StateIndicatorTooltip>
      </span>
    )
  }
  if (status === null || !hasAvatarStatusBadge({ status, sleeping })) {
    return null
  }
  const label = getWorktreeStatusLabel(status) || status
  const glyph =
    sleeping && QUIET_STATUSES.has(status) ? (
      <Moon className="size-3 text-muted-foreground" />
    ) : (
      <StatusIndicator status={status} showTooltip={false} />
    )
  return (
    <span data-worktree-card-status-slot="" className={anchor}>
      <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden>
        {glyph}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  )
}
