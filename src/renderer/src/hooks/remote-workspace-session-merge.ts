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

// Why key presence and not tab count: the host says "no tabs here" in two shapes that demand
// opposite handling, and collapsing them is the entire bug class in this file.
//
//   present, empty array -> the user closed the last tab. Authoritative. Honor it, or a close
//                           performed on one client is silently undone by the next pull.
//   key absent           -> the host has no record for this worktree at all: its export scope
//                           disagreed with ours, or importRemoteWorkspaceSession dropped the entry
//                           because the worktree path did not resolve to exactly one local id.
//                           That is UNKNOWN, not empty — and deleting on it destroys terminals the
//                           user can see, unrecoverably.
//
// Deciding on tab count instead treats both as "delete" (losing data) or both as "keep" (resurrecting
// closed tabs). The distinction is carried intact by exportRemoteWorkspaceSession, JSON, and
// importRemoteWorkspaceSession, so this reads a real signal from the host rather than guessing.
export function narrowDirectSshReplaceWorktreeIds(
  requestedReplaceWorktreeIds: ReadonlySet<string>,
  remote: WorkspaceSessionState
): ReadonlySet<string> {
  return new Set(
    [...requestedReplaceWorktreeIds].filter((worktreeId) =>
      Object.hasOwn(remote.tabsByWorktree, worktreeId)
    )
  )
}

export function mergeDirectSshRemoteWorkspaceSession(
  current: WorkspaceSessionState,
  remote: WorkspaceSessionState,
  requestedReplaceWorktreeIds: ReadonlySet<string>,
  liveTabsByWorktree: AppState['tabsByWorktree'],
  preserveLocalTerminalTabIds: ReadonlySet<string>
): WorkspaceSessionState {
  // Why narrowed here rather than trusted from the caller: this is the boundary that turns a remote
  // report into a local delete, so it must hold on its own. Idempotent, so a caller that already
  // narrowed pays nothing.
  const replaceWorktreeIds = narrowDirectSshReplaceWorktreeIds(requestedReplaceWorktreeIds, remote)
  const inReplaceScope = (worktreeId: string): boolean => replaceWorktreeIds.has(worktreeId)
  // Why remote records are scoped: the snapshot can carry per-worktree entries for worktrees the
  // narrowing protected, and spreading those over current would delete the state it just protected.
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
