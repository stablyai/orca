import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'

export type WorkingTreeCompareEntry = GitBranchChangeEntry & { branchPath: string }

/** Fold index and working-tree paths onto the branch's merge-base paths. */
export function getWorkingTreeCompareEntries(
  branchEntries: readonly GitBranchChangeEntry[],
  statusEntries: readonly GitStatusEntry[]
): WorkingTreeCompareEntry[] {
  const entries = new Map<string, WorkingTreeCompareEntry>(
    branchEntries.map((entry) => [
      entry.path,
      { ...entry, branchPath: entry.path, added: undefined, removed: undefined }
    ])
  )
  const ordered = [...statusEntries].sort(
    (a, b) => Number(a.area !== 'staged') - Number(b.area !== 'staged')
  )
  for (const entry of ordered) {
    if (entry.conflictStatus === 'unresolved') {
      continue
    }
    const previous = entries.get(entry.path) ?? entries.get(entry.oldPath ?? entry.path)
    const oldPath = previous?.oldPath ?? entry.oldPath
    if (entry.status === 'renamed' && entry.oldPath) {
      entries.delete(entry.oldPath)
    }
    entries.set(entry.path, {
      path: entry.path,
      branchPath: previous?.branchPath ?? entry.oldPath ?? entry.path,
      oldPath,
      status:
        entry.status === 'deleted'
          ? 'deleted'
          : previous?.status === 'added'
            ? 'added'
            : entry.status === 'copied' || previous?.status === 'copied'
              ? 'copied'
              : previous?.status === 'deleted' && entry.status === 'untracked'
                ? 'modified'
                : oldPath
                  ? 'renamed'
                  : entry.status === 'untracked'
                    ? 'added'
                    : entry.status,
      added: undefined,
      removed: undefined
    })
  }
  for (const entry of statusEntries) {
    if (entry.conflictStatus === 'unresolved') {
      entries.delete(entry.path)
      if (entry.oldPath) {
        entries.delete(entry.oldPath)
      }
    }
  }
  return [...entries.values()]
}

/** Counts bound automatic loading; they are not the net diff's displayed totals. */
export function getWorkingTreeCompareLineCounts(
  branchEntries: readonly GitBranchChangeEntry[],
  statusEntries: readonly GitStatusEntry[]
): Record<string, { added: number; removed: number }> {
  const counts = new Map<string, { added: number; removed: number } | undefined>()
  const ordered = [...statusEntries].sort(
    (a, b) => Number(a.area !== 'staged') - Number(b.area !== 'staged')
  )
  for (const entry of [...branchEntries, ...ordered]) {
    const path = counts.has(entry.path) ? entry.path : (entry.oldPath ?? entry.path)
    const previous = counts.get(path)
    const hadPrevious = counts.has(path)
    if (entry.status === 'renamed' && entry.oldPath) {
      counts.delete(entry.oldPath)
    }
    const known =
      entry.added !== undefined &&
      entry.removed !== undefined &&
      (!hadPrevious || previous !== undefined)
    counts.set(
      entry.path,
      known
        ? {
            added: (previous?.added ?? 0) + entry.added!,
            removed: (previous?.removed ?? 0) + entry.removed!
          }
        : undefined
    )
  }
  return Object.fromEntries([...counts].flatMap(([path, count]) => (count ? [[path, count]] : [])))
}
