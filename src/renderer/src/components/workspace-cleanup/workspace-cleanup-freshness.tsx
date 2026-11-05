import React from 'react'
import { useNow } from '@/hooks/use-now'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupScanProgress } from '../../../../shared/workspace-cleanup/workspace-cleanup'
import { formatWorkspaceCleanupRelativeTime } from './workspace-cleanup-relative-time'

/** Show the displayed snapshot’s age while a nonblocking rescan indicator streams updates. */
export function WorkspaceCleanupFreshness({
  scannedAt,
  refreshing,
  progress
}: {
  scannedAt: number | null
  refreshing: boolean
  progress: WorkspaceCleanupScanProgress | null
}): React.JSX.Element | null {
  const now = useNow(30_000)
  if (scannedAt === null && !refreshing) {
    return null
  }
  // A fixed suffix, not a ticking counter: the age stays readable and nothing reflows mid-scan.
  return (
    <span className="min-w-0 truncate text-xs text-muted-foreground">
      {scannedAt !== null
        ? translate('components.workspace.cleanup.browse.updatedAgo', 'Updated {{value0}}', {
            value0: formatWorkspaceCleanupRelativeTime(scannedAt, now).toLowerCase()
          })
        : null}
      {scannedAt !== null && refreshing ? ' · ' : null}
      {refreshing ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              {translate('components.workspace.cleanup.browse.refreshing', 'Refreshing…')}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {formatWorkspaceCleanupRefreshingLabel(progress)}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  )
}

function formatWorkspaceCleanupRefreshingLabel(
  progress: WorkspaceCleanupScanProgress | null
): string {
  if (!progress || progress.totalWorktreeCount === 0) {
    return translate('components.workspace.cleanup.browse.refreshing', 'Refreshing…')
  }
  return translate(
    'components.workspace.cleanup.browse.refreshingProgress',
    'Refreshing {{value0}}/{{value1}}',
    { value0: progress.scannedWorktreeCount, value1: progress.totalWorktreeCount }
  )
}
