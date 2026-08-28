import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { reconcileClosedTerminalTabTombstones } from '../../../shared/closed-terminal-tab-tombstones'
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
  replaceExecutionHostId?: ExecutionHostId,
  remoteRevision?: number
): WorkspaceSessionState {
  // Live tabs across the worktrees this snapshot replaces. Close-suppression consults it so a tab
  // that is still live locally always beats its own tombstone.
  // What actually keeps suppression from deleting a tab the user did not close — the earlier claim
  // that "every use is inside replaceWorktreeIds" was wrong, since the tabsByWorktree pass below
  // walks all of orderedWorktreeIds and the layout/session sweeps cover the whole remote maps:
  //   1. closeTab strips the id from EVERY worktree row before recording the tombstone
  //      (terminal-tab-close.ts), so a tombstoned id is not live anywhere;
  //   2. isSuppressedByClose matches the tombstone's own worktreeId, so it cannot reach another
  //      workspace's tab even if an id somehow recurred;
  //   3. only closeReason === 'user' ever writes a tombstone.
  // A final sweep of suppression over the assembled tabsByWorktree — including worktrees
  // omitTargetWorktrees passes through verbatim — is still deliberately absent.
  const currentTabsById = new Map(
    [...replaceWorktreeIds]
      .flatMap((worktreeId) => liveTabsByWorktree[worktreeId] ?? [])
      .map((tab) => [tab.id, tab])
  )
  const locallyPreservedTabIds = new Set<string>()
  const localTabsFor = (worktreeId: string): TerminalTab[] =>
    liveTabsByWorktree[worktreeId] ?? current.tabsByWorktree[worktreeId] ?? []
  // Why presence and not length: an explicit empty row is the record that the user closed the last
  // terminal (initial-terminal.ts), and localTabsFor cannot tell it from an absent one. Admitting
  // only non-empty rows dropped the key, which reads downstream as "never initialized" and seeds a
  // fresh terminal on every reconnect.
  const hasLocalTabsRow = (worktreeId: string): boolean =>
    Object.hasOwn(liveTabsByWorktree, worktreeId) ||
    Object.hasOwn(current.tabsByWorktree, worktreeId)
  // Why the union and not just the remote keys: a host snapshot that has never been told about this
  // worktree carries no entry for it at all, and iterating only its keys would drop every local tab
  // through the omit below.
  const mergedWorktreeIds = new Set([
    ...Object.keys(remote.tabsByWorktree),
    ...[...replaceWorktreeIds].filter(hasLocalTabsRow)
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
  // The other half of the trade below. Absence still cannot say "closed", so this says it instead:
  // a tab THIS client watched the user close, whose close never reached the host. Only ids the user
  // closed are ever in here, and only until the host's own snapshot stops listing them.
  const closedTerminalTabTombstonesByTabId = reconcileClosedTerminalTabTombstones({
    tombstones: current.closedTerminalTabTombstonesByTabId,
    acknowledgedWorktreeIds: new Set(
      [...replaceWorktreeIds].filter((worktreeId) =>
        Object.hasOwn(remote.tabsByWorktree, worktreeId)
      )
    ),
    hostKnownTabIds: remoteKnownTabIds,
    hostRevision: remoteRevision,
    now: Date.now()
  })
  // Why Object.hasOwn and not `in`: the map is a plain object from Object.fromEntries, so `in`
  // answers true for every Object.prototype key on an EMPTY map — a host tab whose id is
  // `toString` would be filtered, blocked from the host-unknown branch, and stripped of its layout
  // and session id. Tab ids are validated only as non-empty and colon-free, and createTab honours
  // caller-supplied id hints, so that id is reachable. This is the one place either direction could
  // delete a tab the user never closed.
  // Why the worktree comparison: the tombstone already carries the worktree it was closed in, so
  // scoping on it makes "this suppression cannot reach another workspace's tab" structural rather
  // than a property of where the call sites happen to sit.
  // Why a live local tab still overrides its own tombstone: an id that is live here means the
  // tombstone is stale (a close undone before it persisted), not a revival. Deleting a live pane is
  // the one outcome this whole function exists to avoid.
  const isSuppressedByClose = (tabId: string, worktreeId: string): boolean =>
    Object.hasOwn(closedTerminalTabTombstonesByTabId, tabId) &&
    closedTerminalTabTombstonesByTabId[tabId]?.worktreeId === worktreeId &&
    !currentTabsById.has(tabId)
  // Ids this merge actually suppressed, recorded as it walks the worktrees. The layout and
  // session-id sweeps below have no worktree in scope, so they consult decisions already made
  // rather than re-deriving one without the scope that makes it safe.
  const suppressedTabIds = new Set<string>()
  const tabsByWorktree = Object.fromEntries(
    orderedWorktreeIds.map((worktreeId) => {
      const remoteTabs = remote.tabsByWorktree[worktreeId] ?? []
      const reconciled = remoteTabs
        .filter((tab) => {
          if (!isSuppressedByClose(tab.id, worktreeId)) {
            return true
          }
          suppressedTabIds.add(tab.id)
          return false
        })
        .map((tab) => {
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
        if (isSuppressedByClose(tab.id, worktreeId)) {
          suppressedTabIds.add(tab.id)
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
        ([tabId]) => !locallyPreservedTabIds.has(tabId) && !suppressedTabIds.has(tabId)
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
      // Why a suppressed id is left in place here: hydration validates both active-tab pointers
      // against the tab rows it just built and nulls anything they no longer name, so nulling twice
      // would only add a second rule that has to stay in step with that one.
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
          ([tabId]) => !locallyPreservedTabIds.has(tabId) && !suppressedTabIds.has(tabId)
        )
      )
    },
    lastVisitedAtByWorktreeId: {
      ...omitTargetVisitRecency(current.lastVisitedAtByWorktreeId),
      ...remote.lastVisitedAtByWorktreeId
    },
    defaultTerminalTabsAppliedByWorktreeId: {
      // Why no omit here: the marker is write-once and is the only guard on applyDefaultTerminalTabs,
      // so a snapshot that omits it is a host that was never told rather than one reporting the tabs
      // were never applied — omitting the local entry re-applies the whole template over the user's
      // tabs. Removal is the worktree-teardown path's job, not a reconnect's.
      ...current.defaultTerminalTabsAppliedByWorktreeId,
      ...remote.defaultTerminalTabsAppliedByWorktreeId
    },
    closedTerminalTabTombstonesByTabId:
      Object.keys(closedTerminalTabTombstonesByTabId).length > 0
        ? closedTerminalTabTombstonesByTabId
        : undefined
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
