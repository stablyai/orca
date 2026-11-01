import type {
  WorkspaceSpaceScanProgress,
  WorkspaceSpaceScanStatus,
  WorkspaceSpaceWorktree
} from '../../../../shared/workspace-space-types'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { translate } from '@/i18n/i18n'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'

export { formatBytes } from '../../../../shared/format-bytes'

const FULL_DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  dateStyle: 'medium',
  timeStyle: 'short'
}

export function formatCompactCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) {
    return '0'
  }
  if (count < 1000) {
    return String(count)
  }
  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}k`
  }
  return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}m`
}

export function getWorkspaceSpaceScanTimeLabel(scannedAt: number, now = Date.now()): string {
  return formatUiRelativeTime(scannedAt - now)
}

export function getWorkspaceSpaceScanDateTimeLabel(scannedAt: number): string {
  return uiDateTimeFormat(FULL_DATE_TIME_OPTIONS).format(new Date(scannedAt))
}

export function getWorkspaceSpaceProgressLabel(
  progress: WorkspaceSpaceScanProgress | null
): string | null {
  if (!progress) {
    return null
  }
  if (progress.state === 'cancelling') {
    return translate(
      'auto.components.status.bar.workspaceSpaceFormat.cancellingScan',
      'Cancelling scan'
    )
  }

  const current =
    progress.currentWorktreeDisplayName ??
    progress.currentRepoDisplayName ??
    translate('auto.components.status.bar.workspaceSpaceFormat.currentWorkspaces', 'workspaces')
  if (progress.totalWorktreeCount > 0) {
    return translate(
      'auto.components.status.bar.workspaceSpaceFormat.scanningWorkspaces',
      'Scanning {{scanned}} of {{total}} · {{current}}',
      {
        scanned: progress.scannedWorktreeCount,
        total: progress.totalWorktreeCount,
        current
      }
    )
  }
  if (progress.totalRepoCount > 0) {
    return translate(
      'auto.components.status.bar.workspaceSpaceFormat.scanningRepos',
      'Scanning {{scanned}} of {{count}} repos · {{current}}',
      {
        scanned: progress.scannedRepoCount,
        count: progress.totalRepoCount,
        current,
        defaultValue_one: 'Scanning {{scanned}} of {{count}} repo · {{current}}'
      }
    )
  }
  return getWorkspaceSpaceScanningFallbackLabel()
}

export function getWorkspaceSpaceScanningFallbackLabel(): string {
  return translate(
    'auto.components.status.bar.workspaceSpaceFormat.scanningSizes',
    'Scanning workspace sizes'
  )
}

export function getWorkspaceSpaceStatusLabel(status: WorkspaceSpaceScanStatus): string {
  switch (status) {
    case 'ok':
      return translate('auto.components.status.bar.workspaceSpaceFormat.status.scanned', 'Scanned')
    case 'missing':
      return translate('auto.components.status.bar.workspaceSpaceFormat.status.missing', 'Missing')
    case 'permission-denied':
      return translate(
        'auto.components.status.bar.workspaceSpaceFormat.status.noAccess',
        'No access'
      )
    case 'unavailable':
      return translate(
        'auto.components.status.bar.workspaceSpaceFormat.status.unavailable',
        'Unavailable'
      )
    case 'error':
      return translate('auto.components.status.bar.workspaceSpaceFormat.status.failed', 'Failed')
  }
}

export function getWorkspaceSpaceBranchLabel(worktree: WorkspaceSpaceWorktree): string {
  const branch = worktree.branch.replace(/^refs\/heads\//, '').trim()
  return (
    branch ||
    (worktree.isMainWorktree
      ? translate('auto.components.status.bar.workspaceSpaceFormat.mainWorktree', 'main worktree')
      : translate('auto.components.status.bar.workspaceSpaceFormat.detached', 'detached'))
  )
}
