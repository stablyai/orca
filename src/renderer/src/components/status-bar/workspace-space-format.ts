import type {
  WorkspaceSpaceScanProgress,
  WorkspaceSpaceScanStatus,
  WorkspaceSpaceWorktree
} from '../../../../shared/workspace-space-types'

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const
const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const fullDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short'
})

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }

  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const precision = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(precision)} ${BYTE_UNITS[unitIndex]}`
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
  const diffMs = scannedAt - now
  const diffMinutes = Math.round(diffMs / 60_000)
  if (Math.abs(diffMinutes) < 60) {
    return relativeTimeFormatter.format(diffMinutes, 'minute')
  }

  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) {
    return relativeTimeFormatter.format(diffHours, 'hour')
  }

  const diffDays = Math.round(diffHours / 24)
  return relativeTimeFormatter.format(diffDays, 'day')
}

export function getWorkspaceSpaceScanDateTimeLabel(scannedAt: number): string {
  return fullDateTimeFormatter.format(new Date(scannedAt))
}

export function getWorkspaceSpaceProgressLabel(
  progress: WorkspaceSpaceScanProgress | null
): string | null {
  if (!progress) {
    return null
  }
  if (progress.state === 'cancelling') {
    return 'Cancelling scan'
  }

  const current =
    progress.currentWorktreeDisplayName ?? progress.currentRepoDisplayName ?? 'workspaces'
  if (progress.totalWorktreeCount > 0) {
    return `Scanning ${progress.scannedWorktreeCount} of ${progress.totalWorktreeCount} · ${current}`
  }
  if (progress.totalRepoCount > 0) {
    return `Scanning ${progress.scannedRepoCount} of ${progress.totalRepoCount} repos · ${current}`
  }
  return 'Scanning workspace sizes'
}

export function getWorkspaceSpaceStatusLabel(status: WorkspaceSpaceScanStatus): string {
  switch (status) {
    case 'ok':
      return 'Scanned'
    case 'missing':
      return 'Missing'
    case 'permission-denied':
      return 'No access'
    case 'unavailable':
      return 'Unavailable'
    case 'error':
      return 'Failed'
  }
}

export function getWorkspaceSpaceBranchLabel(worktree: WorkspaceSpaceWorktree): string {
  const branch = worktree.branch.replace(/^refs\/heads\//, '').trim()
  return branch || (worktree.isMainWorktree ? 'main worktree' : 'detached')
}
