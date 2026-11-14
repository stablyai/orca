import type {
  WorkspaceSpaceScanProgress,
  WorkspaceSpaceScanStatus,
  WorkspaceSpaceWorktree
} from '../../../../shared/workspace-disk-space/workspace-space-types'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
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

export function getWorkspaceSpaceScanTimeLabel(
  scannedAt: number,
  now = Date.now(),
  intlLocale?: string
): string {
  return formatUiRelativeTime(scannedAt - now, intlLocale)
}

export function getWorkspaceSpaceScanDateTimeLabel(scannedAt: number, intlLocale?: string): string {
  return uiDateTimeFormat(FULL_DATE_TIME_OPTIONS, intlLocale).format(new Date(scannedAt))
}

export function getWorkspaceSpaceProgressLabel(
  progress: WorkspaceSpaceScanProgress | null,
  t: Translate = translate
): string | null {
  if (!progress) {
    return null
  }
  if (progress.state === 'cancelling') {
    return t('auto.components.status.bar.workspaceSpaceFormat.cancellingScan', 'Cancelling scan')
  }

  const current =
    progress.currentWorktreeDisplayName ??
    progress.currentRepoDisplayName ??
    t('auto.components.status.bar.workspaceSpaceFormat.currentWorkspaces', 'workspaces')
  if (progress.totalWorktreeCount > 0) {
    return t(
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
    return t(
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
  return getWorkspaceSpaceScanningFallbackLabel(t)
}

export function getWorkspaceSpaceScanningFallbackLabel(t: Translate = translate): string {
  return t(
    'auto.components.status.bar.workspaceSpaceFormat.scanningSizes',
    'Scanning workspace sizes'
  )
}

export function getWorkspaceSpaceStatusLabel(
  status: WorkspaceSpaceScanStatus,
  t: Translate = translate
): string {
  switch (status) {
    case 'ok':
      return t('auto.components.status.bar.workspaceSpaceFormat.status.scanned', 'Scanned')
    case 'missing':
      return t('auto.components.status.bar.workspaceSpaceFormat.status.missing', 'Missing')
    case 'permission-denied':
      return t('auto.components.status.bar.workspaceSpaceFormat.status.noAccess', 'No access')
    case 'unavailable':
      return t('auto.components.status.bar.workspaceSpaceFormat.status.unavailable', 'Unavailable')
    case 'error':
      return t('auto.components.status.bar.workspaceSpaceFormat.status.failed', 'Failed')
  }
}

export function getWorkspaceSpaceBranchLabel(
  worktree: WorkspaceSpaceWorktree,
  t: Translate = translate
): string {
  const branch = worktree.branch.replace(/^refs\/heads\//, '').trim()
  return (
    branch ||
    (worktree.isMainWorktree
      ? t('auto.components.status.bar.workspaceSpaceFormat.mainWorktree', 'main worktree')
      : t('auto.components.status.bar.workspaceSpaceFormat.detached', 'detached'))
  )
}
