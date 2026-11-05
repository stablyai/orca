import type { GitStatusEntry } from './git-status-types'

// Why: conflict state can change (unresolved↔resolved_locally) without the base status changing, so also compare conflict fields.
export function areGitStatusEntriesEqual(
  prev: readonly GitStatusEntry[],
  next: readonly GitStatusEntry[]
): boolean {
  return (
    prev.length === next.length &&
    prev.every(
      (entry, index) =>
        entry.path === next[index].path &&
        entry.status === next[index].status &&
        entry.area === next[index].area &&
        entry.oldPath === next[index].oldPath &&
        entry.conflictKind === next[index].conflictKind &&
        entry.conflictStatus === next[index].conflictStatus &&
        entry.conflictStatusSource === next[index].conflictStatusSource &&
        entry.added === next[index].added &&
        entry.removed === next[index].removed &&
        entry.submoduleRoot === next[index].submoduleRoot &&
        entry.submodule?.commitChanged === next[index].submodule?.commitChanged &&
        entry.submodule?.trackedChanges === next[index].submodule?.trackedChanges &&
        entry.submodule?.untrackedChanges === next[index].submodule?.untrackedChanges &&
        entry.submodule?.restoreRecurses === next[index].submodule?.restoreRecurses
    )
  )
}
