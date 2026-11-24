import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import { normalizeRelativePath } from '../../../../../../shared/file-access/cross-platform-path'

/**
 * Parent-relative paths of dirty submodules the user has expanded. Nested ones come from
 * their parent submodule's loaded entries, so each expanded level reads once its parent has;
 * collapsed or clean submodules never trigger inner Git work.
 */
export function selectExpandedDirtySubmodules(
  parentEntries: readonly GitStatusEntry[],
  expandedRelativePaths: ReadonlySet<string>,
  childEntriesByPath: ReadonlyMap<string, readonly GitStatusEntry[]>
): string[] {
  const selected = new Set<string>()
  let level: readonly GitStatusEntry[] = parentEntries
  while (level.length > 0) {
    const added: string[] = []
    for (const entry of level) {
      const submodule = entry.submodule
      if (!submodule || entry.area === 'staged') {
        continue
      }
      if (!submodule.trackedChanges && !submodule.untrackedChanges) {
        continue
      }
      const path = normalizeRelativePath(entry.path)
      if (expandedRelativePaths.has(path) && !selected.has(path)) {
        selected.add(path)
        added.push(path)
      }
    }
    level = added.flatMap((path) => childEntriesByPath.get(path) ?? [])
  }
  return Array.from(selected).sort()
}
