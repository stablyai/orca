import type { TerminalTab, WorkspaceSessionState } from '../../../shared/types'
import type { DirectSshAuthority } from '../../../shared/ssh-types'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
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

export function directSshTerminalTabKey(worktreeId: string, tabId: string): string {
  return JSON.stringify([worktreeId, tabId])
}

function isTargetPtyId(ptyId: string | null | undefined, targetId: string): ptyId is string {
  return Boolean(ptyId && parseAppSshPtyId(ptyId)?.connectionId === targetId)
}

function hasAmbiguousResultTabIds(
  current: WorkspaceSessionState,
  remote: WorkspaceSessionState,
  replaceWorktreeIds: ReadonlySet<string>
): boolean {
  const ownerByTabId = new Map<string, string>()
  const addOwner = (worktreeId: string, tab: TerminalTab): boolean => {
    const tabId = tab.id
    const owner = ownerByTabId.get(tabId)
    if (owner && owner !== worktreeId) {
      return false
    }
    ownerByTabId.set(tabId, worktreeId)
    return true
  }
  for (const [worktreeId, tabs] of Object.entries(current.tabsByWorktree)) {
    if (!replaceWorktreeIds.has(worktreeId)) {
      for (const tab of tabs) {
        if (!addOwner(worktreeId, tab)) {
          return true
        }
      }
    }
  }
  for (const [worktreeId, tabs] of Object.entries(remote.tabsByWorktree)) {
    for (const tab of tabs) {
      if (!addOwner(worktreeId, tab)) {
        return true
      }
    }
  }
  return false
}

function targetLayout(
  session: WorkspaceSessionState,
  tabId: string,
  targetId: string
): WorkspaceSessionState['terminalLayoutsByTabId'][string] | undefined {
  const layout = session.terminalLayoutsByTabId[tabId]
  if (
    !layout ||
    Object.values(layout.ptyIdsByLeafId ?? {}).some((ptyId) => !isTargetPtyId(ptyId, targetId))
  ) {
    return undefined
  }
  return layout
}

function retainedLocalPtyId(
  current: WorkspaceSessionState,
  reconnectPtyIdByTabId: Readonly<Record<string, string>>,
  tabId: string,
  targetId: string,
  allowTabKeyedRecovery: boolean
): string | undefined {
  const layout = targetLayout(current, tabId, targetId)
  const mountedLeafIds = collectLeafIdsInOrder(layout?.root)
  const primaryLeafId =
    layout?.activeLeafId && mountedLeafIds.includes(layout.activeLeafId)
      ? layout.activeLeafId
      : mountedLeafIds[0]
  const layoutPtyId = primaryLeafId ? layout?.ptyIdsByLeafId?.[primaryLeafId] : undefined
  const reconnectPtyId = allowTabKeyedRecovery ? reconnectPtyIdByTabId[tabId] : undefined
  return isTargetPtyId(reconnectPtyId, targetId)
    ? reconnectPtyId
    : isTargetPtyId(layoutPtyId, targetId)
      ? layoutPtyId
      : undefined
}

export function mergeDirectSshRemoteWorkspaceSession(
  current: WorkspaceSessionState,
  remote: WorkspaceSessionState,
  replaceWorktreeIds: ReadonlySet<string>,
  liveTabsByWorktree: AppState['tabsByWorktree'],
  preserveLocalTerminalTabKeys: ReadonlySet<string>,
  reconnectPtyIdByTabId: Readonly<Record<string, string>>,
  authority: DirectSshAuthority
): WorkspaceSessionState | null {
  if (hasAmbiguousResultTabIds(current, remote, replaceWorktreeIds)) {
    return null
  }
  const { targetId } = authority
  const locallyPreservedTabIds = new Set<string>()
  const locallyPreservedWorktreeIds = new Set<string>()
  const locallyPreservedPtyByTabId = new Map<string, string>()
  const tabsByWorktree = Object.fromEntries(
    Object.entries(remote.tabsByWorktree).map(([worktreeId, tabs]) => [
      worktreeId,
      tabs.map((tab) => {
        const local = (liveTabsByWorktree[worktreeId] ?? []).find(
          (candidate) => candidate.id === tab.id
        )
        const tabKey = directSshTerminalTabKey(worktreeId, tab.id)
        const hasCurrentAuthority = preserveLocalTerminalTabKeys.has(tabKey)
        const retainedPtyId = retainedLocalPtyId(
          current,
          reconnectPtyIdByTabId,
          tab.id,
          targetId,
          hasCurrentAuthority
        )
        const localPtyId = isTargetPtyId(local?.ptyId, targetId) ? local.ptyId : retainedPtyId
        const remoteTab =
          isTargetPtyId(tab.ptyId, targetId) || !tab.ptyId ? tab : { ...tab, ptyId: null }
        if (
          !local ||
          (!localPtyId && !hasCurrentAuthority) ||
          ((local.generation ?? 0) <= (remoteTab.generation ?? 0) &&
            !(localPtyId && !remoteTab.ptyId) &&
            !local.pendingActivationSpawn &&
            !hasCurrentAuthority)
        ) {
          return remoteTab
        }
        locallyPreservedTabIds.add(tab.id)
        locallyPreservedWorktreeIds.add(worktreeId)
        if (localPtyId) {
          locallyPreservedPtyByTabId.set(tab.id, localPtyId)
        }
        return preserveNewerLocalTerminalFields(
          remoteTab,
          { ...local, ptyId: localPtyId ?? null },
          retainedPtyId
        )
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
        ([tabId]) =>
          !replacedTabIds.has(tabId) ||
          (locallyPreservedTabIds.has(tabId) && targetLayout(current, tabId, targetId))
      )
    ),
    ...Object.fromEntries(
      Object.entries(remote.terminalLayoutsByTabId).filter(
        ([tabId]) => !locallyPreservedTabIds.has(tabId) && targetLayout(remote, tabId, targetId)
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
          ([tabId, ptyId]) =>
            !replacedTabIds.has(tabId) ||
            (locallyPreservedTabIds.has(tabId) && isTargetPtyId(ptyId, targetId))
        )
      ),
      ...Object.fromEntries(
        Object.entries(remote.remoteSessionIdsByTabId ?? {}).filter(
          ([tabId, ptyId]) => !locallyPreservedTabIds.has(tabId) && isTargetPtyId(ptyId, targetId)
        )
      ),
      ...Object.fromEntries(
        [...locallyPreservedTabIds]
          .map((tabId) => [tabId, locallyPreservedPtyByTabId.get(tabId)] as const)
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
