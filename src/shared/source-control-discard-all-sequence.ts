import type { GitStatusEntry } from './git-status-types'

export type DiscardAllArea = 'staged' | 'unstaged' | 'untracked'

/** Exclude unresolved/local resolutions from bulk discard to avoid recreating conflicts or losing resolved work. */
export function getDiscardAllPaths(
  entries: readonly GitStatusEntry[],
  area: DiscardAllArea
): string[] {
  return entries
    .filter(
      (entry) =>
        (entry.area === area || (area === 'unstaged' && entry.area === 'untracked')) &&
        entry.conflictStatus !== 'unresolved' &&
        entry.conflictStatus !== 'resolved_locally' &&
        !entry.submoduleRoot &&
        (area === 'staged' || !isWorktreeUndiscardableGitlink(entry))
    )
    .flatMap((entry) =>
      area === 'staged' && entry.status === 'renamed' && entry.oldPath
        ? [entry.path, entry.oldPath]
        : [entry.path]
    )
}

export type StageAllArea = 'unstaged' | 'untracked'

/** Exclude unresolved conflicts before git add clears u records; include local resolutions so staging can finish them. */
export function getStageAllPaths(entries: readonly GitStatusEntry[], area: StageAllArea): string[] {
  return entries
    .filter((entry) => entry.area === area && isStageableStatusEntry(entry))
    .map((entry) => entry.path)
}

export function isStageableStatusEntry(entry: GitStatusEntry): boolean {
  return (
    (entry.area === 'unstaged' || entry.area === 'untracked') &&
    entry.conflictStatus !== 'unresolved' &&
    // Parent git add cannot stage inner submodule worktree files.
    !entry.submoduleRoot &&
    !isSubmoduleWorktreeOnlyChange(entry)
  )
}

/** Non-recursive restore leaves a present submodule's checkout untouched, so only a deleted one can be restored. */
export function isWorktreeUndiscardableGitlink(entry: GitStatusEntry): boolean {
  return !!entry.submodule && entry.status !== 'deleted' && entry.submodule.restoreRecurses !== true
}

export function isSubmoduleWorktreeOnlyChange(entry: GitStatusEntry): boolean {
  const submodule = entry.submodule
  // Parent git add stages changed gitlinks, not submodule file dirtiness.
  return entry.area === 'unstaged' && !!submodule && !submodule.commitChanged
}

/** All staged rows may unstage, including conflicts; git reset HEAD safely mirrors the per-row action. */
export function getUnstageAllPaths(entries: readonly GitStatusEntry[]): string[] {
  return entries
    .filter((entry) => entry.area === 'staged' && !entry.submoduleRoot)
    .flatMap((entry) =>
      entry.status === 'renamed' && entry.oldPath ? [entry.path, entry.oldPath] : [entry.path]
    )
}

export type DiscardAllDeps = {
  /** Unstage the given paths in one IPC round-trip. Only called for 'staged'. */
  bulkUnstage: (paths: string[]) => Promise<void>
  /** Optional bulk IPC; omission retains per-file behavior for older surfaces/tests. */
  discardMany?: (paths: string[]) => Promise<void>
  /** Discard a single path (restore from the index, or remove an untracked file). */
  discardOne: (path: string) => Promise<void>
  /** Report once per failure; callers must aggregate toasts instead of posting one per stuck file. */
  onError?: (error: unknown) => void
}

export type DiscardAllResult = {
  /** Paths whose `discardOne` call resolved successfully. */
  discarded: string[]
  /** Paths whose `discardOne` call rejected. Best-effort: the loop continues past these. */
  failed: string[]
  /** True only when bulk unstage failed before discarding; per-file failures populate failed instead. */
  aborted: boolean
}

/** Unstage before discard so staged deltas cannot survive; abort on unstage failure, then continue best-effort past individual failures. */
export async function runDiscardAllForArea(
  area: DiscardAllArea,
  paths: readonly string[],
  deps: DiscardAllDeps
): Promise<DiscardAllResult> {
  if (paths.length === 0) {
    return { discarded: [], failed: [], aborted: false }
  }

  if (area === 'staged') {
    try {
      await deps.bulkUnstage([...paths])
    } catch (error) {
      deps.onError?.(error)
      return { discarded: [], failed: [], aborted: true }
    }
  }

  if (deps.discardMany) {
    try {
      await deps.discardMany([...paths])
      return { discarded: [...paths], failed: [], aborted: false }
    } catch {
      // Older SSH relays may lack bulk discard; fall back to the established per-file calls.
    }
  }

  const discarded: string[] = []
  const failed: string[] = []
  for (const path of paths) {
    try {
      await deps.discardOne(path)
      discarded.push(path)
    } catch (error) {
      failed.push(path)
      deps.onError?.(error)
    }
  }
  return { discarded, failed, aborted: false }
}
