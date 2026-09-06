import type { AppState } from '../../types'

/**
 * Scratch shared by one multi-workspace reconciliation fold.
 *
 * Reconciling N workspaces one `set()` at a time re-spreads the same
 * workspace-keyed maps N times and rescans `openFiles` N times. A batch lets
 * the fold clone each map once and then write into its own private draft, and
 * index `openFiles` once — `openFiles` is never written by reconciliation, so
 * the index stays valid for the whole fold.
 */
export type WorktreeTabModelReconciliationBatch = {
  /** Top-level `AppState` keys this fold already cloned and therefore owns. */
  readonly ownedStateKeys: Set<string>
  readonly liveEditorIdsByWorktree: ReadonlyMap<string, Set<string>>
}

export const EMPTY_LIVE_EDITOR_IDS: ReadonlySet<string> = new Set<string>()

export function createWorktreeTabModelReconciliationBatch(
  state: Pick<AppState, 'openFiles'>
): WorktreeTabModelReconciliationBatch {
  const liveEditorIdsByWorktree = new Map<string, Set<string>>()
  for (const file of state.openFiles) {
    let ids = liveEditorIdsByWorktree.get(file.worktreeId)
    if (!ids) {
      ids = new Set<string>()
      liveEditorIdsByWorktree.set(file.worktreeId, ids)
    }
    ids.add(file.id)
  }
  return { ownedStateKeys: new Set<string>(), liveEditorIdsByWorktree }
}

/**
 * Sets one workspace entry, mutating the batch's own draft once it owns the
 * map. Insertion order matches the spread it replaces: an existing key keeps
 * its slot, a new key is appended.
 */
export function writeBatchedWorkspaceRecordEntry<T>(
  current: Record<string, T>,
  stateKey: string,
  worktreeId: string,
  // `undefined` is accepted because the spread this replaces also stored it.
  value: T | undefined,
  batch: WorktreeTabModelReconciliationBatch | undefined
): Record<string, T> {
  if (batch?.ownedStateKeys.has(stateKey)) {
    ;(current as Record<string, T | undefined>)[worktreeId] = value
    return current
  }
  const next = { ...current, [worktreeId]: value } as Record<string, T>
  batch?.ownedStateKeys.add(stateKey)
  return next
}
