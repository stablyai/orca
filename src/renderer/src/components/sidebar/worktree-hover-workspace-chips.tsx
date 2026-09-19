import React from 'react'
import { Moon } from 'lucide-react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { HoverFactCell } from './worktree-hover-fact-grid'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../../shared/workspace-status-defaults'
import { useWorktreeActivityStatus } from './use-worktree-activity-status'
import { getWorkspaceStatusVisualMeta } from './workspace-status'

/**
 * The two chips that need live state rather than what the card already resolved:
 * the board status with its own colour, and whether the workspace is asleep.
 * Mounted inside the hover content, so a closed row subscribes to nothing.
 */
export function WorktreeHoverWorkspaceChips({
  worktreeId,
  workspaceStatusId
}: {
  worktreeId: string
  workspaceStatusId?: string
}): React.JSX.Element | null {
  const configuredStatuses = useAppStore((s) => s.workspaceStatuses)
  const activityStatus = useWorktreeActivityStatus(worktreeId)
  const statuses =
    configuredStatuses && configuredStatuses.length > 0
      ? configuredStatuses
      : DEFAULT_WORKSPACE_STATUSES
  const status = workspaceStatusId
    ? statuses.find((candidate) => candidate.id === workspaceStatusId)
    : undefined
  const statusMeta = status ? getWorkspaceStatusVisualMeta(status) : null
  const StatusIcon = statusMeta?.icon
  const asleep = activityStatus === 'inactive'

  if (!status && !asleep) {
    return null
  }

  const sleepingLabel = translate(
    'auto.components.sidebar.worktreeHoverCard.sleeping',
    'Sleeping, nothing running in this workspace'
  )

  return (
    <>
      {status && StatusIcon && (
        <HoverFactCell
          icon={<StatusIcon />}
          label={status.label}
          tooltip={status.label}
          className={statusMeta?.tone}
        />
      )}
      {asleep && (
        <HoverFactCell
          icon={<Moon />}
          label={translate('auto.components.sidebar.worktreeHoverCard.asleep', 'Sleeping')}
          tooltip={sleepingLabel}
        />
      )}
    </>
  )
}
