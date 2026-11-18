import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import { normalizeRelativePath } from '../../../../../../shared/file-access/cross-platform-path'

export type SelectedSubmodule = {
  /** Parent-relative path, including any enclosing submodules. */
  path: string
  /** HEAD moved off the recorded commit; older hosts cannot read it without range rows. */
  moved: boolean
}

/**
 * Dirty submodules the user has expanded. Nested ones come from their parent submodule's
 * loaded entries, so each expanded level reads once its parent has; collapsed or clean
 * submodules never trigger inner Git work.
 */
export function selectExpandedDirtySubmodules(
  parentEntries: readonly GitStatusEntry[],
  expandedRelativePaths: ReadonlySet<string>,
  childEntriesByPath: ReadonlyMap<string, readonly GitStatusEntry[]>
): SelectedSubmodule[] {
  const movedByPath = new Map<string, boolean>()
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
      if (!expandedRelativePaths.has(path)) {
        continue
      }
      const known = movedByPath.get(path)
      if (known === undefined) {
        added.push(path)
      }
      movedByPath.set(path, known === true || submodule.commitChanged)
    }
    level = added.flatMap((path) => childEntriesByPath.get(path) ?? [])
  }
  return Array.from(movedByPath, ([path, moved]) => ({ path, moved })).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  )
}
