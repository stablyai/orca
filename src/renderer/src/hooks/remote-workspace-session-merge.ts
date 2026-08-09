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
  const tabsByWorktree: Record<string, TerminalTab[]> = Object.fromEntries(
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
  const incomingTabIds = new Set(
    Object.values(tabsByWorktree).flatMap((tabs) => tabs.map((tab) => tab.id))
  )
  for (const worktreeId of replaceWorktreeIds) {
    const survivingLocalTabs = (liveTabsByWorktree[worktreeId] ?? []).filter(
      (tab) => preserveLocalTerminalTabIds.has(tab.id) && !incomingTabIds.has(tab.id)
    )
    if (survivingLocalTabs.length === 0) {
      continue
    }
    // Why: a successfully reattached durable PTY is stronger evidence than a stale relay snapshot that omitted its tab.
    tabsByWorktree[worktreeId] = [...(tabsByWorktree[worktreeId] ?? []), ...survivingLocalTabs]
    for (const tab of survivingLocalTabs) {
      locallyPreservedTabIds.add(tab.id)
    }
  }
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
  const activeTabIdByWorktree = {
    ...omitTargetWorktrees(current.activeTabIdByWorktree),
    ...remote.activeTabIdByWorktree
  }
  for (const worktreeId of replaceWorktreeIds) {
    const tabs = tabsByWorktree[worktreeId] ?? []
    const rememberedTabId = current.activeTabIdByWorktree?.[worktreeId]
    const currentTabId = current.activeWorktreeId === worktreeId ? current.activeTabId : null
    const localTabId = [currentTabId, rememberedTabId].find((tabId): tabId is string =>
      Boolean(tabId && tabs.some((tab) => tab.id === tabId))
    )
    if (localTabId) {
      activeTabIdByWorktree[worktreeId] = localTabId
    }
  }
  const activeWorktreeIsRestorable = Boolean(
    current.activeWorktreeId &&
    (!replaceWorktreeIds.has(current.activeWorktreeId) ||
      Object.hasOwn(tabsByWorktree, current.activeWorktreeId))
  )
  const activeWorktreeId = activeWorktreeIsRestorable
    ? current.activeWorktreeId
    : remote.activeWorktreeId
  const activeTargetTabs = activeWorktreeId ? (tabsByWorktree[activeWorktreeId] ?? []) : []
  const activeTargetTabCandidate = activeWorktreeId
    ? (activeTabIdByWorktree[activeWorktreeId] ??
      (remote.activeWorktreeId === activeWorktreeId ? remote.activeTabId : null))
    : null
  const activeTabId =
    activeWorktreeId && replaceWorktreeIds.has(activeWorktreeId)
      ? activeTargetTabs.some((tab) => tab.id === activeTargetTabCandidate)
        ? activeTargetTabCandidate
        : (activeTargetTabs[0]?.id ?? null)
      : current.activeTabId
  const activeWorkspaceKey =
    activeWorktreeIsRestorable &&
    current.activeWorktreeId &&
    !replaceWorktreeIds.has(current.activeWorktreeId)
      ? current.activeWorkspaceKey
      : activeWorktreeId
        ? worktreeWorkspaceKey(activeWorktreeId)
        : null
  return {
    ...current,
    activeRepoId: activeWorktreeIsRestorable ? current.activeRepoId : remote.activeRepoId,
    activeWorktreeId,
    activeWorkspaceKey,
    activeTabId,
    tabsByWorktree: {
      ...omitTargetWorktrees(current.tabsByWorktree),
      ...tabsByWorktree
    },
    terminalLayoutsByTabId,
    activeWorktreeIdsOnShutdown: [
      ...(current.activeWorktreeIdsOnShutdown ?? []).filter((id) => !replaceWorktreeIds.has(id)),
      ...(remote.activeWorktreeIdsOnShutdown ?? [])
    ],
    activeTabIdByWorktree,
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
