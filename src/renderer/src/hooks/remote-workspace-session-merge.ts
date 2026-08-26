import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { splitWorktreeId } from '../../../shared/worktree/id'
import {
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
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
  preserveLocalTerminalTabIds: ReadonlySet<string>,
  replaceExecutionHostId?: ExecutionHostId
): WorkspaceSessionState {
  const currentTabsById = new Map(
    [...replaceWorktreeIds]
      .flatMap((worktreeId) => liveTabsByWorktree[worktreeId] ?? [])
      .map((tab) => [tab.id, tab])
  )
  const locallyPreservedTabIds = new Set<string>()
  const localTabsFor = (worktreeId: string): TerminalTab[] =>
    liveTabsByWorktree[worktreeId] ?? current.tabsByWorktree[worktreeId] ?? []
  // Why the union and not just the remote keys: a host snapshot that has never been told about this
  // worktree carries no entry for it at all, and iterating only its keys would drop every local tab
  // through the omit below.
  const mergedWorktreeIds = new Set([
    ...Object.keys(remote.tabsByWorktree),
    ...[...replaceWorktreeIds].filter((worktreeId) => localTabsFor(worktreeId).length > 0)
  ])
  // The active worktree is walked FIRST so that when one tab id is held locally under two of them,
  // the copy that survives below is the one the user is looking at. That matches what
  // resolveActiveTabOwnerWorktreeId already prefers when it has to pick an owner, so the merge and
  // the repair agree instead of each choosing differently.
  const orderedWorktreeIds = [...mergedWorktreeIds].sort(
    (a, b) => Number(b === current.activeWorktreeId) - Number(a === current.activeWorktreeId)
  )
  // Every id already emitted by an earlier worktree in THIS merge. Without it the host-unknown
  // branch below only excludes ids the host knows, so a tab id that local state already holds under
  // two worktrees is re-added under both — two panes sharing one entry in terminalLayoutsByTabId and
  // one in remoteSessionIdsByTabId, which means one remote PTY, plus the unconvergeable activeTabId
  // that active-tab-owner-worktree.ts exists to mitigate (React #185).
  //
  // The merge does not create that state; it used to destroy it, by deleting every local tab under a
  // replaced worktree. Keeping live panes cost that accidental cure, so the guarantee is restored for
  // exactly the branch below: a LOCALLY-HELD tab is never re-added under a worktree this walk has
  // already emitted it in.
  //
  // Deliberately not phrased as "no id twice". The set is consulted only by the host-unknown filter;
  // `reconciled` maps the host's own list verbatim, so a snapshot that lists one tab id under two
  // worktrees still propagates both. That is pre-existing and unchanged — the old code mapped those
  // same entries — and it is the host's own contradiction rather than one this function introduces.
  //
  // Deliberately not stronger than that. A worktree that is neither replaced nor named by the host is
  // never walked — its tabs pass through from `current` verbatim — so a duplicate straddling that
  // boundary still survives, and the only place to catch it is after both halves are assembled.
  // Doing it there was tried and REVERTED: the tie-break has to pick a survivor, and every rule
  // available at that point is wrong during a worktree-id change, which is the very thing that
  // produces these duplicates. Preferring the active worktree keeps the OLD id's copy at the moment a
  // rename lands, because the active worktree has not moved yet — which left the new worktree with no
  // tabs, so its groups were never created, and remote-workspace-snapshot-duplicate-tab-repair.test
  // .ts caught it. A duplicate is survivable and already mitigated by active-tab-owner-worktree.ts;
  // deleting the tabs of the worktree the user is about to land in is not.
  const emittedTabIds = new Set<string>()
  const remoteKnownTabIds = new Set(
    Object.values(remote.tabsByWorktree).flatMap((tabs) => tabs.map((tab) => tab.id))
  )
  // Why sessions and not just tab ids: the host can carry the same agent session under a NEW tab id,
  // and keeping the local tab as well would put one launched agent on the screen twice. The session
  // id is the identity that survives a tab-id change, so a session the host already lists means the
  // local tab is a stale alias rather than something the host has never seen.
  const remoteKnownSessionIds = new Set(
    Object.entries(remote.remoteSessionIdsByTabId ?? {})
      .filter(([tabId]) => remoteKnownTabIds.has(tabId))
      .map(([, sessionId]) => sessionId)
  )
  const tabsByWorktree = Object.fromEntries(
    orderedWorktreeIds.map((worktreeId) => {
      const remoteTabs = remote.tabsByWorktree[worktreeId] ?? []
      const reconciled = remoteTabs.map((tab) => {
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
      for (const tab of reconciled) {
        emittedTabIds.add(tab.id)
      }
      if (!replaceWorktreeIds.has(worktreeId)) {
        return [worktreeId, reconciled]
      }
      // Why: the host is authoritative for what it knows, not for what it has never been told. A tab
      // created locally whose upload was still pending is absent from the snapshot for the same
      // reason it is new — deleting it here loses a live pane and the process running in it.
      //
      // The trade this accepts: absence cannot distinguish "never uploaded" from "closed by another
      // client on this host", so a tab closed elsewhere survives here until that client's snapshot
      // is applied. Closing on THIS client removes it from local state, so the common case is
      // unaffected. Keeping a tab a moment too long is recoverable — the user closes it — while
      // deleting a live one is not, and that is the failure this branch exists to prevent.
      // Why the id is checked against EVERY worktree and not just this one: the same tab id can be
      // owned by two worktrees while a rename settles, and re-adding it here would keep recreating
      // the duplicate the repair pass is trying to converge. A host that knows the id anywhere has
      // been told about the tab, so it is not host-unknown.
      const hostUnknown = localTabsFor(worktreeId).filter((tab) => {
        if (remoteKnownTabIds.has(tab.id) || emittedTabIds.has(tab.id)) {
          return false
        }
        const localSessionId = current.remoteSessionIdsByTabId?.[tab.id]
        return localSessionId == null || !remoteKnownSessionIds.has(localSessionId)
      })
      for (const tab of hostUnknown) {
        // Keeps the tab's layout and remote session id from being swept with the replaced ids below.
        locallyPreservedTabIds.add(tab.id)
        emittedTabIds.add(tab.id)
      }
      return [worktreeId, [...reconciled, ...hostUnknown]]
    })
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
  const omitTargetVisitRecency = (
    record: Record<string, number> | undefined
  ): Record<string, number> =>
    Object.fromEntries(
      Object.entries(record ?? {}).filter(([key]) => {
        const worktreeId = isWorktreeHostIdentity(key) ? getWorktreeIdFromHostIdentity(key) : key
        if (!replaceWorktreeIds.has(worktreeId)) {
          return true
        }
        // A direct SSH snapshot replaces one host's row. Legacy bare keys
        // remain because they may be the only recency evidence for a sibling
        // host; a qualified key is removed only for the target host.
        return Boolean(
          replaceExecutionHostId &&
          (!isWorktreeHostIdentity(key) ||
            key.slice(0, key.indexOf('|')) !== replaceExecutionHostId)
        )
      })
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
  // Why this is narrow: a null from the host is not always missing information. A null activeTabId
  // is a deliberate deselect that arms the duplicate-tab repair, so it is honoured verbatim below.
  // A null activeWorktreeId is different — it is what a snapshot carries when the host never named
  // the workspace or its path did not resolve to a local id, and taking that literally drops the
  // user onto the home screen while their terminals keep running. So it is only overridden when the
  // workspace they are standing in demonstrably still exists in the merged result.
  const localActiveWorkspaceSurvives =
    current.activeWorktreeId != null &&
    replaceWorktreeIds.has(current.activeWorktreeId) &&
    (tabsByWorktree[current.activeWorktreeId]?.length ?? 0) > 0
  const preservedActiveWorktreeId = localActiveWorkspaceSurvives ? current.activeWorktreeId : null
  // The three active-* fields have to describe ONE workspace, so they are all derived from whichever
  // worktree wins rather than each choosing a source. Taking the repo from the host while the
  // worktree came from local state left the pair disagreeing — and precisely in the case the
  // preservation exists for, since "the host named no worktree" is exactly when it can still name a
  // repo.
  const keepsLocalWorkspace =
    !activeOutsideTarget && remote.activeWorktreeId == null && preservedActiveWorktreeId != null
  const activeWorktreeId = activeOutsideTarget
    ? current.activeWorktreeId
    : (remote.activeWorktreeId ?? preservedActiveWorktreeId)
  return {
    ...current,
    activeRepoId:
      activeOutsideTarget || keepsLocalWorkspace ? current.activeRepoId : remote.activeRepoId,
    activeWorktreeId,
    activeWorkspaceKey: activeOutsideTarget
      ? current.activeWorkspaceKey
      : activeWorktreeId
        ? worktreeWorkspaceKey(activeWorktreeId)
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
      // Why the local entry survives: same rule one level down. A host that names no active tab for
      // the target reopens the workspace on whatever sorts first, which is not where the user was.
      ...omitTargetWorktrees(current.activeTabIdByWorktree),
      ...Object.fromEntries(
        [...replaceWorktreeIds].flatMap((worktreeId) => {
          const localActiveTabId = current.activeTabIdByWorktree?.[worktreeId]
          return localActiveTabId == null ? [] : [[worktreeId, localActiveTabId] as const]
        })
      ),
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
      ...omitTargetVisitRecency(current.lastVisitedAtByWorktreeId),
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
