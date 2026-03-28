import type { GitFileStatus, GitStatusEntry } from '../../../../shared/types'
import { normalizeRelativePath } from '@/lib/path'

export const STATUS_LABELS: Record<GitFileStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  copied: 'C'
}

export const STATUS_COLORS: Record<GitFileStatus, string> = {
  modified: 'var(--git-decoration-modified)',
  added: 'var(--git-decoration-added)',
  deleted: 'var(--git-decoration-deleted)',
  renamed: 'var(--git-decoration-renamed)',
  untracked: 'var(--git-decoration-untracked)',
  copied: 'var(--git-decoration-copied)'
}

const STATUS_PRIORITY: Record<GitFileStatus, number> = {
  deleted: 5,
  modified: 4,
  added: 3,
  untracked: 3,
  renamed: 2,
  copied: 1
}

export function getDominantStatus(statuses: Iterable<GitFileStatus>): GitFileStatus | null {
  let dominantStatus: GitFileStatus | null = null
  let dominantPriority = -1

  for (const status of statuses) {
    const priority = STATUS_PRIORITY[status]
    if (priority > dominantPriority) {
      dominantStatus = status
      dominantPriority = priority
    }
  }

  return dominantStatus
}

export function buildStatusMap(entries: GitStatusEntry[]): Map<string, GitFileStatus> {
  const statusByPath = new Map<string, GitFileStatus>()

  for (const entry of entries) {
    const path = normalizeRelativePath(entry.path)
    const existing = statusByPath.get(path)
    const resolved = existing
      ? (getDominantStatus([existing, entry.status]) ?? entry.status)
      : entry.status
    statusByPath.set(path, resolved)
  }

  return statusByPath
}

export function shouldPropagateStatus(status: GitFileStatus): boolean {
  return status !== 'deleted'
}
