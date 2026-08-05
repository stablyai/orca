import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { splitWorktreeId } from '../../../shared/worktree/id'
import type { AppState } from '../store/types'

function preserveNewerLocalTerminalFields(remote: TerminalTab, local: TerminalTab): TerminalTab {
  const preserved = {
    ...remote,
    generation: local.generation,
    ptyId: local.ptyId
  }
  return local.pendingActivationSpawn
    ? { ...preserved, pendingActivationSpawn: local.pendingActivationSpawn }
    : preserved
}

// Why a worktree with local tabs but no remote tabs leaves the replace scope: the snapshot carries
// no tombstones, so "no tabs" from the remote is indistinguishable from a snapshot that regressed
// or was poisoned by an earlier export bug — and honoring it deletes terminal surfaces the user can
// see, unrecoverably. Keeping local state for that worktree is always recoverable: the next push
// re-exports it, and a genuinely emptied worktree converges once the remote reports any tab for it.
//
// The caller must pass the narrowed set both to the merge and to every hydration step keyed by
// replace scope (replaceWorkspaceKeys) — a protected worktree left in that scope still gets its live
// tabs reset and swept into PTY reconnect by the hydration pipeline.
export function narrowDirectSshReplaceWorktreeIds(
  requestedReplaceWorktreeIds: ReadonlySet<string>,
  current: WorkspaceSessionState,
  remote: WorkspaceSessionState,
  liveTabsByWorktree: AppState['tabsByWorktree']
): ReadonlySet<string> {
  return new Set(
    [...requestedReplaceWorktreeIds].filter((worktreeId) => {
      const localTabs = liveTabsByWorktree[worktreeId] ?? current.tabsByWorktree[worktreeId] ?? []
      return localTabs.length === 0 || (remote.tabsByWorktree[worktreeId] ?? []).length > 0
    })
  )
}

export function mergeDirectSshRemoteWorkspaceSession(
  current: WorkspaceSessionState,
  remote: WorkspaceSessionState,
  replaceWorktreeIds: ReadonlySet<string>,
  liveTabsByWorktree: AppState['tabsByWorktree'],
  preserveLocalTerminalTabIds: ReadonlySet<string>
): WorkspaceSessionState {
  // Why remote records are filtered to the replace scope: the remote session may still carry entries
  // for worktrees the caller narrowed out (e.g. an empty tab list), and spreading those over current
  // would delete the very state the narrowing protects.
  const inReplaceScope = (worktreeId: string): boolean => replaceWorktreeIds.has(worktreeId)
  const scopedRemoteRecord = <T>(record: Record<string, T> | undefined): [string, T][] =>
    Object.entries(record ?? {}).filter(([worktreeId]) => inReplaceScope(worktreeId))
  const currentTabsById = new Map(
    [...replaceWorktreeIds]
      .flatMap((worktreeId) => liveTabsByWorktree[worktreeId] ?? [])
      .map((tab) => [tab.id, tab])
  )
  const locallyPreservedTabIds = new Set<string>()
  const tabsByWorktree = Object.fromEntries(
    scopedRemoteRecord(remote.tabsByWorktree).map(([worktreeId, tabs]) => [
      worktreeId,
      tabs.map((tab) => {
        const local = currentTabsById.get(tab.id)
        if (
          !local ||
          ((local.generation ?? 0) <= (tab.generation ?? 0) &&
            !local.pendingActivationSpawn &&
            !preserveLocalTerminalTabIds.has(tab.id))
        ) {
          return tab
        }
        locallyPreservedTabIds.add(tab.id)
        return preserveNewerLocalTerminalFields(tab, local)
      })
    ])
  )
  const remoteTabIds = new Set(
    Object.values(tabsByWorktree).flatMap((tabs) => tabs.map((tab) => tab.id))
  )
  const replacedTabIds = new Set([
    ...remoteTabIds,
    ...Object.entries(current.tabsByWorktree)
      .filter(([worktreeId]) => replaceWorktreeIds.has(worktreeId))
      .flatMap(([, tabs]) => tabs.map((tab) => tab.id))
  ])
  const omitTargetWorktrees = <T>(record: Record<string, T> | undefined): Record<string, T> =>
    Object.fromEntries(
      Object.entries(record ?? {}).filter(([worktreeId]) => !replaceWorktreeIds.has(worktreeId))
    )
  const terminalLayoutsByTabId = {
    ...Object.fromEntries(
      Object.entries(current.terminalLayoutsByTabId).filter(
        ([tabId]) => !replacedTabIds.has(tabId) || locallyPreservedTabIds.has(tabId)
      )
    ),
    ...Object.fromEntries(
      Object.entries(remote.terminalLayoutsByTabId).filter(
        ([tabId]) => !locallyPreservedTabIds.has(tabId)
      )
    )
  }
  const activeOutsideTarget =
    current.activeWorktreeId != null && !replaceWorktreeIds.has(current.activeWorktreeId)
  return {
    ...current,
    activeRepoId: activeOutsideTarget ? current.activeRepoId : remote.activeRepoId,
    activeWorktreeId: activeOutsideTarget ? current.activeWorktreeId : remote.activeWorktreeId,
    activeWorkspaceKey: activeOutsideTarget
      ? current.activeWorkspaceKey
      : remote.activeWorktreeId
        ? worktreeWorkspaceKey(remote.activeWorktreeId)
        : null,
    activeTabId: activeOutsideTarget ? current.activeTabId : remote.activeTabId,
    tabsByWorktree: {
      ...omitTargetWorktrees(current.tabsByWorktree),
      ...tabsByWorktree
    },
    terminalLayoutsByTabId,
    activeWorktreeIdsOnShutdown: [
      ...(current.activeWorktreeIdsOnShutdown ?? []).filter((id) => !replaceWorktreeIds.has(id)),
      ...(remote.activeWorktreeIdsOnShutdown ?? []).filter(inReplaceScope)
    ],
    activeTabIdByWorktree: {
      ...omitTargetWorktrees(current.activeTabIdByWorktree),
      ...Object.fromEntries(scopedRemoteRecord(remote.activeTabIdByWorktree))
    },
    remoteSessionIdsByTabId: {
      ...Object.fromEntries(
        Object.entries(current.remoteSessionIdsByTabId ?? {}).filter(
          ([tabId]) => !replacedTabIds.has(tabId) || locallyPreservedTabIds.has(tabId)
        )
      ),
      ...Object.fromEntries(
        Object.entries(remote.remoteSessionIdsByTabId ?? {}).filter(
          ([tabId]) => !locallyPreservedTabIds.has(tabId)
        )
      )
    },
    lastVisitedAtByWorktreeId: {
      ...omitTargetWorktrees(current.lastVisitedAtByWorktreeId),
      ...Object.fromEntries(scopedRemoteRecord(remote.lastVisitedAtByWorktreeId))
    },
    defaultTerminalTabsAppliedByWorktreeId: {
      ...omitTargetWorktrees(current.defaultTerminalTabsAppliedByWorktreeId),
      ...Object.fromEntries(scopedRemoteRecord(remote.defaultTerminalTabsAppliedByWorktreeId))
    }
  }
}

export function uniqueWorktreeIdByPath(
  worktreeIds: ReadonlySet<string>
): (worktreePath: string) => string | null {
  const byPath = new Map<string, string | null>()
  for (const worktreeId of worktreeIds) {
    const path = splitWorktreeId(worktreeId)?.worktreePath
    if (!path) {
      continue
    }
    byPath.set(path, byPath.has(path) ? null : worktreeId)
  }
  return (worktreePath) => byPath.get(worktreePath) ?? null
}
