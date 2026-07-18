import { normalizeRelativePath } from '@/lib/path'
import type { GitStatusEntry } from '../../../../shared/types'

export type FileExplorerGitPathState = 'deleted' | 'unresolved-conflict'

function groupEntriesByPath(entries: readonly GitStatusEntry[]): Map<string, GitStatusEntry[]> {
  const grouped = new Map<string, GitStatusEntry[]>()
  for (const entry of entries) {
    const relativePath = normalizeRelativePath(entry.path)
    if (!relativePath) {
      continue
    }
    const pathEntries = grouped.get(relativePath)
    if (pathEntries) {
      pathEntries.push(entry)
    } else {
      grouped.set(relativePath, [entry])
    }
  }
  return grouped
}

export function buildFileExplorerGitPathStateMap(
  entries: readonly GitStatusEntry[]
): Map<string, FileExplorerGitPathState> {
  const states = new Map<string, FileExplorerGitPathState>()
  for (const [relativePath, pathEntries] of groupEntriesByPath(entries)) {
    if (pathEntries.some((entry) => entry.conflictStatus === 'unresolved')) {
      states.set(relativePath, 'unresolved-conflict')
      continue
    }

    const workingTreeEntry = pathEntries.find(
      (entry) => entry.area === 'unstaged' || entry.area === 'untracked'
    )
    // Why: a staged deletion can be recreated as an untracked working-tree file;
    // only treat it as missing when no present working-tree entry supersedes it.
    if (
      workingTreeEntry?.status === 'deleted' ||
      (!workingTreeEntry && pathEntries.some((entry) => entry.status === 'deleted'))
    ) {
      states.set(relativePath, 'deleted')
    }
  }
  return states
}

function entryPriority(entry: GitStatusEntry): number {
  if (entry.conflictStatus === 'unresolved') {
    return 5
  }
  if (entry.area === 'unstaged' && entry.status === 'deleted') {
    return 4
  }
  if (entry.area === 'untracked') {
    return 3
  }
  if (entry.area === 'unstaged') {
    return 2
  }
  return 1
}

export function selectFileExplorerGitEntryForPath(
  entries: readonly GitStatusEntry[],
  relativePath: string
): GitStatusEntry | null {
  const normalizedPath = normalizeRelativePath(relativePath)
  let selected: GitStatusEntry | null = null
  let selectedPriority = -1
  for (const entry of entries) {
    if (normalizeRelativePath(entry.path) !== normalizedPath) {
      continue
    }
    const priority = entryPriority(entry)
    if (priority > selectedPriority) {
      selected = entry
      selectedPriority = priority
    }
  }
  return selected
}
