import type { OpenFile } from '@/store/slices/editor'
import type { GitBranchChangeEntry, GitStatusEntry } from '../../../../shared/types'
import type { CombinedDiffFileTreeMode } from './combined-diff-file-tree-model'

/**
 * Fallback filtering for combined-diff tabs that were opened before the
 * snapshot field existed. When a snapshot is present the caller should use it
 * directly (after filtering out unresolved conflicts) instead of calling this.
 */
export function getCombinedUncommittedEntries(
  liveEntries: GitStatusEntry[],
  areaFilter: OpenFile['combinedAreaFilter']
): GitStatusEntry[] {
  return liveEntries.filter((entry) => {
    if (entry.conflictStatus === 'unresolved') {
      return false
    }
    return areaFilter === undefined || entry.area === areaFilter
  })
}

export function resolveCombinedUncommittedSnapshotEntries(
  snapshotEntries: readonly GitStatusEntry[],
  liveEntries: readonly GitStatusEntry[],
  retainedResolvedEntries: readonly GitStatusEntry[] = []
): GitStatusEntry[] {
  const liveEntriesByPath = getGitStatusEntriesByPath(liveEntries)
  const retainedEntriesByPath = getGitStatusEntriesByPath(retainedResolvedEntries)
  const snapshotAreaKeys = new Set(snapshotEntries.map(getUncommittedAreaPathKey))
  const resolvedEntries: GitStatusEntry[] = []
  const resolvedAreaKeys = new Set<string>()
  const pushResolvedEntry = (entry: GitStatusEntry): void => {
    const areaKey = getUncommittedAreaPathKey(entry)
    if (resolvedAreaKeys.has(areaKey)) {
      return
    }
    resolvedAreaKeys.add(areaKey)
    resolvedEntries.push(entry)
  }

  for (const snapshotEntry of snapshotEntries) {
    const livePathEntries = liveEntriesByPath.get(snapshotEntry.path) ?? []
    if (livePathEntries.some((liveEntry) => liveEntry.area === snapshotEntry.area)) {
      pushResolvedEntry(snapshotEntry)
      continue
    }

    const retainedPathEntries = retainedEntriesByPath.get(snapshotEntry.path) ?? []
    if (
      livePathEntries.length === 0 &&
      retainedPathEntries.some((retainedEntry) => retainedEntry.area === snapshotEntry.area)
    ) {
      pushResolvedEntry(snapshotEntry)
      continue
    }

    const movedEntry =
      livePathEntries[0] ?? (retainedPathEntries.length === 1 ? retainedPathEntries[0] : undefined)
    if (!movedEntry || movedEntry.area === snapshotEntry.area) {
      pushResolvedEntry(snapshotEntry)
      continue
    }

    const movedAreaKey = getUncommittedAreaPathKey({
      path: snapshotEntry.path,
      area: movedEntry.area
    })
    if (snapshotAreaKeys.has(movedAreaKey)) {
      continue
    }
    if (resolvedAreaKeys.has(movedAreaKey)) {
      continue
    }

    // Why: a snapshot-backed Changes tab can outlive stage/unstage actions.
    // Load the area Git now reports so Monaco doesn't diff identical files.
    pushResolvedEntry({
      ...snapshotEntry,
      area: movedEntry.area,
      status: movedEntry.status,
      oldPath: movedEntry.oldPath,
      added: movedEntry.added,
      removed: movedEntry.removed,
      submodule: movedEntry.submodule
    })
  }

  return resolvedEntries
}

function getGitStatusEntriesByPath(
  entries: readonly GitStatusEntry[]
): Map<string, GitStatusEntry[]> {
  const entriesByPath = new Map<string, GitStatusEntry[]>()
  for (const entry of entries) {
    const pathEntries = entriesByPath.get(entry.path)
    if (pathEntries) {
      pathEntries.push(entry)
    } else {
      entriesByPath.set(entry.path, [entry])
    }
  }
  return entriesByPath
}

function getUncommittedAreaPathKey(entry: Pick<GitStatusEntry, 'area' | 'path'>): string {
  return `${entry.area}\0${entry.path}`
}

export function getCombinedBranchEntries(
  snapshotEntries: readonly GitBranchChangeEntry[] | undefined,
  liveEntries: readonly GitBranchChangeEntry[]
): GitBranchChangeEntry[] {
  // Why: an explicitly empty tab snapshot should stay empty instead of drifting
  // to later Source Control refreshes.
  return [...(snapshotEntries ?? liveEntries)]
}

export function shouldAutoReloadCombinedDiffFromGitStatus({
  mode,
  hasUncommittedEntriesSnapshot
}: {
  mode: CombinedDiffFileTreeMode
  hasUncommittedEntriesSnapshot: boolean
}): boolean {
  // Why: snapshot-backed tabs preserve the tab-open file list while
  // staging/commit status churns; targeted editor-write reloads still refresh.
  return mode === 'uncommitted' && !hasUncommittedEntriesSnapshot
}
