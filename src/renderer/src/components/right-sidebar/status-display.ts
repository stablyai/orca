import type { GitFileStatus, GitStatusEntry } from '../../../../shared/types'
import { joinPath, normalizeRelativePath } from '@/lib/path'
import { splitPathSegments } from './path-tree'

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

export function buildFolderStatusMap(entries: GitStatusEntry[]): Map<string, GitFileStatus | null> {
  const folderStatuses = new Map<string, GitFileStatus[]>()

  for (const entry of entries) {
    if (!shouldPropagateStatus(entry.status)) {
      continue
    }

    const segments = splitPathSegments(entry.path)
    if (segments.length <= 1) {
      continue
    }

    let currentPath = ''
    for (const segment of segments.slice(0, -1)) {
      currentPath = currentPath ? joinPath(currentPath, segment) : segment
      const statuses = folderStatuses.get(currentPath)
      if (statuses) {
        statuses.push(entry.status)
      } else {
        folderStatuses.set(currentPath, [entry.status])
      }
    }
  }

  return new Map(
    Array.from(folderStatuses.entries()).map(([folderPath, statuses]) => [
      folderPath,
      getDominantStatus(statuses)
    ])
  )
}

export function shouldPropagateStatus(status: GitFileStatus): boolean {
  return status !== 'deleted'
}

export function isPathIgnored(ignored: Set<string>, relativePath: string): boolean {
  if (ignored.size === 0) {
    return false
  }
  if (ignored.has(relativePath)) {
    return true
  }
  let candidate = relativePath
  for (;;) {
    const idx = candidate.lastIndexOf('/')
    if (idx <= 0) {
      return false
    }
    candidate = candidate.slice(0, idx)
    if (ignored.has(candidate)) {
      return true
    }
  }
}

export function shouldShowIgnoredDecoration(
  nodeStatus: GitFileStatus | null,
  ignored: Set<string>,
  relativePath: string
): boolean {
  return !nodeStatus && isPathIgnored(ignored, relativePath)
}

export function buildIgnoredSet(ignoredPaths: readonly string[] | undefined): Set<string> {
  const set = new Set<string>()
  if (!ignoredPaths) {
    return set
  }
  for (const rawPath of ignoredPaths) {
    const trimmed = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath
    set.add(normalizeRelativePath(trimmed))
  }
  return set
}
