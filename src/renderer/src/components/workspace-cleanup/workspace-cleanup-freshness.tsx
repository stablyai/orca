import React from 'react'
import { Loader2 } from 'lucide-react'
import { useNow } from '@/hooks/use-now'
import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupScanProgress } from '../../../../shared/workspace-cleanup'
import { formatWorkspaceCleanupRelativeTime } from './workspace-cleanup-relative-time'

/**
 * Fixed-slot freshness line: "Updated 2h ago" for the data on screen plus a
 * non-blocking "Refreshing" affordance while a background rescan streams.
 */
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
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      {scannedAt !== null ? (
        <span className="truncate">
          {translate('components.workspace.cleanup.browse.updatedAgo', 'Updated {{value0}}', {
            value0: formatWorkspaceCleanupRelativeTime(scannedAt, now).toLowerCase()
          })}
        </span>
      ) : null}
      {refreshing ? (
        <span className="flex shrink-0 items-center gap-1">
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          {formatWorkspaceCleanupRefreshingLabel(progress)}
        </span>
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
