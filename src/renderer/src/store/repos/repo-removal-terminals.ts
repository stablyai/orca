import type { AppState } from '../types'

// Why: per store, the worktree ids each in-flight removeProject will purge itself (after killing their PTYs).
const worktreeIdsBeingRemoved = new WeakMap<() => AppState, Set<ReadonlySet<string>>>()

export function beginRepoRemoval(get: () => AppState, worktreeIds: string[]): ReadonlySet<string> {
  const removal = new Set(worktreeIds)
  let removals = worktreeIdsBeingRemoved.get(get)
  if (!removals) {
    removals = new Set()
    worktreeIdsBeingRemoved.set(get, removals)
  }
  removals.add(removal)
  return removal
}

export function endRepoRemoval(get: () => AppState, removal: ReadonlySet<string>): void {
  worktreeIdsBeingRemoved.get(get)?.delete(removal)
}

export function withoutWorktreesBeingRemoved(get: () => AppState, ids: string[]): string[] {
  const removals = worktreeIdsBeingRemoved.get(get)
  if (!removals || removals.size === 0) {
    return ids
  }
  return ids.filter((id) => ![...removals].some((removal) => removal.has(id)))
}

export type RemovalTabPtyIds = { worktreeId: string; tabId: string; ptyIds: string[] }

export function readRemovalTabPtyIds(state: AppState, ids: Iterable<string>): RemovalTabPtyIds[] {
  return [...ids].flatMap((worktreeId) =>
    (state.tabsByWorktree[worktreeId] ?? []).map((tab) => ({
      worktreeId,
      tabId: tab.id,
      ptyIds: state.ptyIdsByTabId[tab.id] ?? []
    }))
  )
}

// Why: one kill set per removal, so a PTY seen by several reads is killed once.
export function createLocalPtyKiller(): (ptyIds: string[]) => void {
  const killedPtyIds = new Set<string>()
  return (ptyIds) => {
    for (const ptyId of ptyIds) {
      if (!ptyId.startsWith('remote:') && !killedPtyIds.has(ptyId)) {
        killedPtyIds.add(ptyId)
        window.api.pty.kill(ptyId)
      }
    }
  }
}
