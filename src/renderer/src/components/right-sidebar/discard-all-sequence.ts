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

export type StageAllArea = 'unstaged' | 'untracked'

/**
 * Collect the paths a "Stage all" action should operate on.
 * Unresolved conflict rows are excluded — `git add` on a conflicted file
 * silently clears the `u` record before the user has reviewed it.
 * `resolved_locally` rows are intentionally INCLUDED: staging them is how the
 * user finalises the resolution and mirrors the per-row Stage button.
 */
export function getStageAllPaths(entries: readonly GitStatusEntry[], area: StageAllArea): string[] {
  return entries
    .filter((entry) => entry.area === area && entry.conflictStatus !== 'unresolved')
    .map((entry) => entry.path)
}

/**
 * Collect the paths an "Unstage all" action should operate on.
 * Every staged row is eligible — `git reset HEAD` on a staged conflict
 * row is safe and mirrors the per-row Unstage action.
 */
export function getUnstageAllPaths(entries: readonly GitStatusEntry[]): string[] {
  return entries.filter((entry) => entry.area === 'staged').map((entry) => entry.path)
}

export type DiscardAllDeps = {
  /** Unstage the given paths in one IPC round-trip. Only called for 'staged'. */
  bulkUnstage: (paths: string[]) => Promise<void>
  /**
   * Discard the given paths in one IPC round-trip. Callers may omit this to
   * keep the legacy per-file sequence in tests or older surfaces.
   */
  discardMany?: (paths: string[]) => Promise<void>
  /** Discard a single path (restore working-tree to HEAD, or rm if untracked). */
  discardOne: (path: string) => Promise<void>
  /**
   * Called when either the pre-step (bulkUnstage) rejects OR an individual
   * `discardOne` rejects. Invoked once per failure so callers can surface
   * each error (e.g. a toast per stuck file) rather than swallowing them.
   */
  onError?: (error: unknown) => void
}

export type DiscardAllResult = {
  /** Paths whose `discardOne` call resolved successfully. */
  discarded: string[]
  /** Paths whose `discardOne` call rejected. Best-effort: the loop continues past these. */
  failed: string[]
  /**
   * True only when the pre-step (bulk unstage for the 'staged' area) failed
   * and we never entered the per-file discard loop. Per-file failures do
   * NOT set this flag — they are reported via `failed`.
   */
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
 *
 * Per-file `discardOne` failures are best-effort: we continue past a failed
 * file so a single stuck path does not block the rest of the bulk action.
 * Failed paths are reported via `failed`, `onError` is invoked once per
 * failure, and `aborted` remains `false` because the loop ran end-to-end.
 */
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
      // Why: older SSH relays may not support the bulk discard RPC yet. Fall
      // back to the long-standing per-file path so the action still completes.
    }
  }

  const discarded: string[] = []
  const failed: string[] = []
  for (const path of paths) {
    try {
      await deps.discardOne(path)
      discarded.push(path)
    } catch (error) {
      // Best-effort: record and continue so one stuck file doesn't block the
      // rest of the bulk action.
      failed.push(path)
      deps.onError?.(error)
    }
  }
  return { discarded, failed, aborted: false }
}
