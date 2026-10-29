import type { AppState } from '../../types'

/** One multi-workspace fold clones each shared map once and indexes read-only openFiles once, avoiding repeated map spreads and file scans per workspace. */
export type WorktreeTabModelReconciliationBatch = {
  readonly ownedStateKeys: Set<'unreadTerminalTabs'>
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
  return { ownedStateKeys: new Set(), liveEditorIdsByWorktree }
}
