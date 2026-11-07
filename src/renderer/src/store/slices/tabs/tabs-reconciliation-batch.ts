import type { AppState } from '../../types'

/** One multi-workspace fold clones each shared map once and indexes read-only openFiles once, avoiding repeated map spreads and file scans per workspace. */
export type WorktreeTabModelReconciliationBatch = {
  /** Top-level `AppState` keys this fold already cloned and therefore owns. */
  readonly ownedStateKeys: Set<string>
  readonly liveEditorIds: ReadonlySet<string>
}

export function createWorktreeTabModelReconciliationBatch(
  state: Pick<AppState, 'openFiles'>
): WorktreeTabModelReconciliationBatch {
  return {
    ownedStateKeys: new Set<string>(),
    liveEditorIds: new Set(state.openFiles.map((file) => file.id))
  }
}

/** Mutate only batch-owned maps; preserve spread insertion order (existing keys keep their slot, new keys append). */
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
  // Equal present entries preserve identity without claiming ownership; absent keys still insert, matching spread semantics.
  if (worktreeId in current && Object.is(current[worktreeId], value)) {
    return current
  }
  const next = { ...current, [worktreeId]: value } as Record<string, T>
  batch?.ownedStateKeys.add(stateKey)
  return next
}
