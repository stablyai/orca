import type { JSX } from 'react'
import { WorkspaceRateLimitWatcherMenuItem } from './WorkspaceRateLimitWatcherMenuItem'
import { WorkspaceScheduledMessagesMenuItem } from './WorkspaceScheduledMessagesMenuItem'

type WorkspaceAgentMenuItemsProps = {
  worktreeId: string
  disabled: boolean
  pendingScheduledCount: number
  onOpenScheduleDialog: () => void
}

export function WorkspaceAgentMenuItems({
  worktreeId,
  disabled,
  pendingScheduledCount,
  onOpenScheduleDialog
}: WorkspaceAgentMenuItemsProps): JSX.Element {
  return (
    <>
      <WorkspaceRateLimitWatcherMenuItem worktreeId={worktreeId} disabled={disabled} />
      <WorkspaceScheduledMessagesMenuItem
        pendingCount={pendingScheduledCount}
        disabled={disabled}
        onSelect={onOpenScheduleDialog}
      />
    </>
  )
}
