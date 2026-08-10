import type { TerminalTab, WorkspaceSessionState } from '../../../shared/types'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { splitWorktreeId } from '../../../shared/worktree-id'
import type { AppState } from '../store/types'
import { collectLeafIdsInOrder } from '../components/terminal-pane/terminal-layout-leaf-ids'

function preserveNewerLocalTerminalFields(
  remote: TerminalTab,
  local: TerminalTab,
  retainedPtyId?: string
): TerminalTab {
  const preserved = {
    ...remote,
    generation: local.generation,
    ptyId: local.ptyId ?? retainedPtyId ?? null
  }
  return local.pendingActivationSpawn
    ? { ...preserved, pendingActivationSpawn: local.pendingActivationSpawn }
    : preserved
}

function retainedLocalPtyId(
  current: WorkspaceSessionState,
  reconnectPtyIdByTabId: Readonly<Record<string, string>>,
  tabId: string
): string | undefined {
  const layout = current.terminalLayoutsByTabId[tabId]
  const mountedLeafIds = collectLeafIdsInOrder(layout?.root)
  const primaryLeafId =
    layout?.activeLeafId && mountedLeafIds.includes(layout.activeLeafId)
      ? layout.activeLeafId
      : mountedLeafIds[0]
  const layoutPtyId = primaryLeafId ? layout?.ptyIdsByLeafId?.[primaryLeafId] : undefined
  return reconnectPtyIdByTabId[tabId] ?? layoutPtyId
}

export function mergeDirectSshRemoteWorkspaceSession(
  current: WorkspaceSessionState,
  remote: WorkspaceSessionState,
  replaceWorktreeIds: ReadonlySet<string>,
  liveTabsByWorktree: AppState['tabsByWorktree'],
  preserveLocalTerminalTabIds: ReadonlySet<string>,
  reconnectPtyIdByTabId: Readonly<Record<string, string>>
): WorkspaceSessionState {
  const currentTabsById = new Map(
    [...replaceWorktreeIds]
      .flatMap((worktreeId) => liveTabsByWorktree[worktreeId] ?? [])
      .map((tab) => [tab.id, tab])
  )
  const locallyPreservedTabIds = new Set<string>()
  const locallyPreservedWorktreeIds = new Set<string>()
  const tabsByWorktree = Object.fromEntries(
    Object.entries(remote.tabsByWorktree).map(([worktreeId, tabs]) => [
      worktreeId,
      tabs.map((tab) => {
        const local = currentTabsById.get(tab.id)
        const retainedPtyId = retainedLocalPtyId(current, reconnectPtyIdByTabId, tab.id)
        if (
          !local ||
          ((local.generation ?? 0) <= (tab.generation ?? 0) &&
            !((local.ptyId || retainedPtyId) && !tab.ptyId) &&
            !local.pendingActivationSpawn &&
            !preserveLocalTerminalTabIds.has(tab.id))
        ) {
          return tab
        }
        locallyPreservedTabIds.add(tab.id)
        locallyPreservedWorktreeIds.add(worktreeId)
        return preserveNewerLocalTerminalFields(tab, local, retainedPtyId)
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
      ...new Set([
        ...(current.activeWorktreeIdsOnShutdown ?? []).filter(
          (id) => !replaceWorktreeIds.has(id) || locallyPreservedWorktreeIds.has(id)
        ),
        ...locallyPreservedWorktreeIds,
        ...(remote.activeWorktreeIdsOnShutdown ?? [])
      ])
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
      ),
      ...Object.fromEntries(
        [...locallyPreservedTabIds]
          .map(
            (tabId) => [tabId, retainedLocalPtyId(current, reconnectPtyIdByTabId, tabId)] as const
          )
          .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
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
