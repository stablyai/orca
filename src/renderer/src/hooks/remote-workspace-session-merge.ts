import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { DirectSshAuthority } from '../../../shared/ssh-types'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { splitWorktreeId } from '../../../shared/worktree/id'
import type { AppState } from '../store/types'
import {
  hasAmbiguousResultTabIds,
  isTargetPtyId,
  retainedLocalPtyId,
  targetLayout
} from './remote-workspace-session-merge-guards'

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
  // Graft pass: the snapshot's tab list is the last exported state, not a close
  // ledger, so a local row the snapshot does not know is appended rather than
  // dropped when it is pty-bound to this connection, holds recovery authority,
  // or carries a pending activation spawn. Snapshot-known ids follow the
  // snapshot's placement.
  const graftedTabIds = new Set<string>()
  const graftOnlyWorktreeIds = new Set<string>()
  const nonReplaceOwnedTabIds = new Set(
    Object.entries(liveTabsByWorktree)
      .filter(([worktreeId]) => !replaceWorktreeIds.has(worktreeId))
      .flatMap(([, tabs]) => tabs.map((tab) => tab.id))
  )
  for (const worktreeId of replaceWorktreeIds) {
    const grafts = (liveTabsByWorktree[worktreeId] ?? []).filter(
      (tab) =>
        !remoteTabIds.has(tab.id) &&
        !nonReplaceOwnedTabIds.has(tab.id) &&
        (isTargetPtyId(tab.ptyId, targetId) ||
          Object.values(targetLayout(current, tab.id, targetId)?.ptyIdsByLeafId ?? {}).some(
            Boolean
          ) ||
          preserveLocalTerminalTabKeys.has(directSshTerminalTabKey(worktreeId, tab.id)) ||
          Boolean(tab.pendingActivationSpawn))
    )
    if (grafts.length === 0) {
      continue
    }
    for (const tab of grafts) {
      // The same graft-eligible id under two replace-scope worktrees is the
      // ambiguity hasAmbiguousResultTabIds fails closed on for snapshot rows.
      if (graftedTabIds.has(tab.id)) {
        return null
      }
      graftedTabIds.add(tab.id)
    }
    if (remote.tabsByWorktree[worktreeId] === undefined) {
      graftOnlyWorktreeIds.add(worktreeId)
    }
    locallyPreservedWorktreeIds.add(worktreeId)
    tabsByWorktree[worktreeId] = [
      ...(tabsByWorktree[worktreeId] ?? []),
      ...grafts.map((tab) => (isTargetPtyId(tab.ptyId, targetId) ? tab : { ...tab, ptyId: null }))
    ]
  }
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
          ((locallyPreservedTabIds.has(tabId) || graftedTabIds.has(tabId)) &&
            targetLayout(current, tabId, targetId))
      )
    ),
    ...Object.fromEntries(
      Object.entries(remote.terminalLayoutsByTabId).filter(
        ([tabId]) =>
          !locallyPreservedTabIds.has(tabId) &&
          !graftedTabIds.has(tabId) &&
          targetLayout(remote, tabId, targetId)
      )
    )
  }
  // A worktree reconstituted only by grafting has no snapshot entry to supply
  // its active-tab bookkeeping, so the local entries survive for it.
  const graftOnlyActiveTabByWorktree: Record<string, string | null> = {}
  for (const worktreeId of graftOnlyWorktreeIds) {
    const tabs = tabsByWorktree[worktreeId] ?? []
    const currentActive = current.activeTabIdByWorktree?.[worktreeId]
    graftOnlyActiveTabByWorktree[worktreeId] =
      currentActive && tabs.some((tab) => tab.id === currentActive)
        ? currentActive
        : (tabs[0]?.id ?? null)
  }
  const activeOutsideTarget =
    current.activeWorktreeId != null && !replaceWorktreeIds.has(current.activeWorktreeId)
  const activeWorktreeGraftOnly =
    current.activeWorktreeId != null && graftOnlyWorktreeIds.has(current.activeWorktreeId)
  const keepCurrentActive = activeOutsideTarget || activeWorktreeGraftOnly
  let graftOnlyActiveTabId: string | null = null
  if (activeWorktreeGraftOnly && current.activeWorktreeId) {
    const tabs = tabsByWorktree[current.activeWorktreeId] ?? []
    graftOnlyActiveTabId =
      current.activeTabId && tabs.some((tab) => tab.id === current.activeTabId)
        ? current.activeTabId
        : (graftOnlyActiveTabByWorktree[current.activeWorktreeId] ?? null)
  }
  return {
    ...current,
    activeRepoId: keepCurrentActive ? current.activeRepoId : remote.activeRepoId,
    activeWorktreeId: keepCurrentActive ? current.activeWorktreeId : remote.activeWorktreeId,
    activeWorkspaceKey: keepCurrentActive
      ? current.activeWorkspaceKey
      : remote.activeWorktreeId
        ? worktreeWorkspaceKey(remote.activeWorktreeId)
        : null,
    activeTabId: activeOutsideTarget
      ? current.activeTabId
      : activeWorktreeGraftOnly
        ? graftOnlyActiveTabId
        : remote.activeTabId,
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
      ...remote.activeTabIdByWorktree,
      ...graftOnlyActiveTabByWorktree
    },
    remoteSessionIdsByTabId: {
      ...Object.fromEntries(
        Object.entries(current.remoteSessionIdsByTabId ?? {}).filter(
          ([tabId, ptyId]) =>
            !replacedTabIds.has(tabId) ||
            ((locallyPreservedTabIds.has(tabId) || graftedTabIds.has(tabId)) &&
              isTargetPtyId(ptyId, targetId))
        )
      ),
      ...Object.fromEntries(
        Object.entries(remote.remoteSessionIdsByTabId ?? {}).filter(
          ([tabId, ptyId]) =>
            !locallyPreservedTabIds.has(tabId) &&
            !graftedTabIds.has(tabId) &&
            isTargetPtyId(ptyId, targetId)
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
