import type { GitFileStatus, GitStatusEntry } from './git-status-types'

type StatusPath = Pick<GitStatusEntry, 'path' | 'status' | 'submodule' | 'submoduleRoot'>
import { normalizeRelativePath, splitPathSegments } from '../../file-access/cross-platform-path'

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

export function buildStatusMap(entries: readonly StatusPath[]): Map<string, GitFileStatus> {
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
  entries: readonly StatusPath[]
): Map<string, GitFileStatus | null> {
  const folderStatuses = new Map<string, GitFileStatus[]>()

  for (const entry of entries) {
    if (!shouldPropagateStatus(entry.status)) {
      continue
    }

    const segments = splitPathSegments(entry.path)
    // A dirty submodule is a directory in the explorer, so it carries its own folder status.
    const folderSegments =
      entry.submodule && !entry.submoduleRoot ? segments : segments.slice(0, -1)
    if (folderSegments.length === 0) {
      continue
    }

    let currentPath = ''
    for (const segment of folderSegments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
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
