import type {
  WorkspaceSpaceScanStatus,
  WorkspaceSpaceWorktree
} from '../../../../shared/workspace-space-types'

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

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

export function getWorkspaceSpaceScanTimeLabel(scannedAt: number): string {
  return new Date(scannedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
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
