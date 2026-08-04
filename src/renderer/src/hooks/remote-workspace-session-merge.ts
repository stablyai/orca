import type { TerminalTab, WorkspaceSessionState } from '../../../shared/types'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { splitWorktreeId } from '../../../shared/worktree-id'
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

export function mergeDirectSshRemoteWorkspaceSession(
  current: WorkspaceSessionState,
  remote: WorkspaceSessionState,
  replaceWorktreeIds: ReadonlySet<string>,
  liveTabsByWorktree: AppState['tabsByWorktree'],
  preserveLocalTerminalTabIds: ReadonlySet<string>
): WorkspaceSessionState {
  const currentTabsById = new Map(
    [...replaceWorktreeIds]
      .flatMap((worktreeId) => liveTabsByWorktree[worktreeId] ?? [])
      .map((tab) => [tab.id, tab])
  )
  const locallyPreservedTabIds = new Set<string>()
  const tabsByWorktree = Object.fromEntries(
    Object.entries(remote.tabsByWorktree).map(([worktreeId, tabs]) => [
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
      ...(remote.activeWorktreeIdsOnShutdown ?? [])
    ],
    activeTabIdByWorktree: {
      ...omitTargetWorktrees(current.activeTabIdByWorktree),
      ...remote.activeTabIdByWorktree
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
      ...remote.lastVisitedAtByWorktreeId
    },
    defaultTerminalTabsAppliedByWorktreeId: {
      ...omitTargetWorktrees(current.defaultTerminalTabsAppliedByWorktreeId),
      ...remote.defaultTerminalTabsAppliedByWorktreeId
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
