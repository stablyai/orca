import type { GitStatusEntry } from '../../../../shared/types'

export type DiscardAllArea = 'staged' | 'unstaged' | 'untracked'

/**
 * Collect the paths a "Discard all" bulk action should operate on for a given
 * area. Unresolved and locally-resolved conflicts are excluded — discarding
 * those can silently re-create the conflict or lose the resolution.
 */
export function getDiscardAllPaths(
  entries: readonly GitStatusEntry[],
  area: DiscardAllArea
): string[] {
  return entries
    .filter(
      (entry) =>
        entry.area === area &&
        entry.conflictStatus !== 'unresolved' &&
        entry.conflictStatus !== 'resolved_locally'
    )
    .map((entry) => entry.path)
}

export type DiscardAllDeps = {
  /** Unstage the given paths in one IPC round-trip. Only called for 'staged'. */
  bulkUnstage: (paths: string[]) => Promise<void>
  /** Discard a single path (restore working-tree to HEAD, or rm if untracked). */
  discardOne: (path: string) => Promise<void>
  /** Called if bulkUnstage rejects. Lets the caller surface an error. */
  onError?: (error: unknown) => void
}

export type DiscardAllResult = {
  /** Paths that reached the discard step. */
  discarded: string[]
  /** True if we bailed before the discard loop (e.g. bulkUnstage failed). */
  aborted: boolean
}

/**
 * Run the "Discard all" sequence for a given area.
 *
 * For 'staged', this first bulk-unstages the paths — without that step,
 * `discardOne` (which maps to `git restore --worktree --source=HEAD`) would
 * reset the working tree to HEAD but leave the index carrying the staged
 * delta, producing phantom inverse "Changes" rows the user thought they just
 * discarded. If the unstage fails we MUST skip the discard loop entirely for
 * the same reason: a stale index with a clean worktree is a worse state than
 * the one the user started in.
 */
export async function runDiscardAllForArea(
  area: DiscardAllArea,
  paths: readonly string[],
  deps: DiscardAllDeps
): Promise<DiscardAllResult> {
  if (paths.length === 0) {
    return { discarded: [], aborted: false }
  }

  if (area === 'staged') {
    try {
      await deps.bulkUnstage([...paths])
    } catch (error) {
      deps.onError?.(error)
      return { discarded: [], aborted: true }
    }
  }

  const discarded: string[] = []
  for (const path of paths) {
    await deps.discardOne(path)
    discarded.push(path)
  }
  return { discarded, aborted: false }
}
