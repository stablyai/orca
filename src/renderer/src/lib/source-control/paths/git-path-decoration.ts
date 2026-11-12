import type {
  GitFileStatus,
  GitStatusEntry
} from '../../../../../shared/git/status/git-status-types'
import { joinPath } from '@/lib/path'
import { normalizeRelativePath, splitPathSegments } from '../../../../../shared/cross-platform-path'

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

export function buildStatusMap(entries: readonly GitStatusEntry[]): Map<string, GitFileStatus> {
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

export function buildFolderStatusMap(
  entries: readonly GitStatusEntry[]
): Map<string, GitFileStatus | null> {
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

export type RepositoryIgnoredPathSet = Set<string> & {
  repositories?: ReadonlyMap<string, ReadonlyMap<string, boolean>>
}

export function isPathIgnored(ignored: RepositoryIgnoredPathSet, relativePath: string): boolean {
  if (ignored.repositories) {
    let parent = relativePath
    for (;;) {
      const slash = parent.lastIndexOf('/')
      parent = slash === -1 ? '' : parent.slice(0, slash)
      const own = ignored.repositories.get(parent)
      if (own) {
        let path = parent ? relativePath.slice(parent.length + 1) : relativePath
        for (;;) {
          const answer = own.get(path)
          if (answer !== undefined) {
            return answer
          }
          const index = path.lastIndexOf('/')
          if (index === -1) {
            return false
          }
          path = path.slice(0, index)
        }
      }
      if (parent === '') {
        break
      }
    }
  }
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

export function buildIgnoredSet(
  ignoredPaths: readonly string[] | undefined,
  rootPath?: string | null
): Set<string> {
  const set = new Set<string>()
  if (!ignoredPaths) {
    return set
  }
  for (const rawPath of ignoredPaths) {
    const path = normalizeRelativePath(rawPath, rootPath)
    set.add(path.endsWith('/') ? path.slice(0, -1) : path)
  }
  return set
}
