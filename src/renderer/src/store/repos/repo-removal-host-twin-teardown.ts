import type { AppState } from '../types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { buildTerminalTabRetirementPlans } from '../slices/terminal-tab-retirement'
import { omitSleepingAgentSessionsForWorktrees } from '../slices/worktrees/teardown/sleeping-agent-session-omission'
import type { RecentlyClosedTabKind } from '../slices/recently-closed-tabs'
import { omitRecordKeys } from '../slices/worktrees/teardown/record-key-omission'
import { cancelStructuredLaunchesForWorktrees } from '../slices/worktrees/teardown/worktree-purge-state'
import {
  belongsToRemovedHost,
  collectRemovedHostTwinState,
  isRuntimeHost,
  mergeRemovedHostTwinState,
  openFileHostEvidence,
  removedHostCanonicalizer,
  pageHostEvidence,
  type HostEvidence,
  type RemovedHostTwinState
} from './repo-removal-host-twin-attribution'

/** Which entries of one reopen stack are the removed host's; unmarked ones may be the survivor's. */
function prunedEntries<T>(stack: readonly T[] | undefined, isRemoved: (entry: T) => boolean) {
  const pruned = (stack ?? []).map(isRemoved)
  return pruned.includes(true) ? pruned : null
}

/** The n-th kind entry of a type is that type's n-th snapshot, so pruned ones go from both. */
function dropPrunedKinds(
  kinds: readonly RecentlyClosedTabKind[],
  kind: RecentlyClosedTabKind,
  pruned: readonly boolean[]
): RecentlyClosedTabKind[] {
  let index = 0
  return kinds.filter((entry) => entry !== kind || !pruned[index++])
}

function pruneRemovedHostReopenHistory(
  state: AppState,
  twinHostIds: ReadonlyMap<string, readonly ExecutionHostId[]>,
  removedHostId: ExecutionHostId
): Partial<AppState> | null {
  const editors = { ...state.recentlyClosedEditorTabsByWorktree }
  const browsers = { ...state.recentlyClosedBrowserTabsByWorktree }
  const kinds = { ...state.recentlyClosedTabKindsByWorktree }
  let changed = false
  for (const [worktreeId, survivors] of twinHostIds) {
    const canonical = removedHostCanonicalizer(state, worktreeId, removedHostId, survivors)
    const editorPruned = prunedEntries(editors[worktreeId], (snapshot) =>
      belongsToRemovedHost(canonical(openFileHostEvidence(snapshot)), removedHostId, survivors)
    )
    const browserPruned = prunedEntries(
      browsers[worktreeId],
      (snapshot) =>
        snapshot.pages.length > 0 &&
        snapshot.pages
          .map(pageHostEvidence)
          .every((evidence) => belongsToRemovedHost(canonical(evidence), removedHostId, survivors))
    )
    if (editorPruned) {
      editors[worktreeId] = (editors[worktreeId] ?? []).filter((_, i) => !editorPruned[i])
      kinds[worktreeId] = dropPrunedKinds(kinds[worktreeId] ?? [], 'editor', editorPruned)
    }
    if (browserPruned) {
      browsers[worktreeId] = (browsers[worktreeId] ?? []).filter((_, i) => !browserPruned[i])
      kinds[worktreeId] = dropPrunedKinds(kinds[worktreeId] ?? [], 'browser', browserPruned)
    }
    changed ||= Boolean(editorPruned || browserPruned)
  }
  return changed
    ? {
        recentlyClosedEditorTabsByWorktree: editors,
        recentlyClosedBrowserTabsByWorktree: browsers,
        recentlyClosedTabKindsByWorktree: kinds
      }
    : null
}

/** Sleeping-agent records can outlive their tab, so they are matched by the host they name too. */
function omitRemovedHostSleepingSessions(
  state: AppState,
  twinHostIds: ReadonlyMap<string, readonly ExecutionHostId[]>,
  removedHostId: ExecutionHostId,
  removed: RemovedHostTwinState
): ReturnType<typeof omitSleepingAgentSessionsForWorktrees> {
  const doomedPaneKeys: string[] = []
  for (const [paneKey, record] of Object.entries(state.sleepingAgentSessionsByPaneKey ?? {})) {
    const survivors = twinHostIds.get(record.worktreeId)
    if (!survivors) {
      continue
    }
    const evidence: HostEvidence =
      record.connectionId === undefined
        ? null
        : record.connectionId
          ? toSshExecutionHostId(record.connectionId)
          : 'non-runtime'
    if (
      (record.tabId !== undefined && removed.terminalTabIds.has(record.tabId)) ||
      belongsToRemovedHost(
        removedHostCanonicalizer(state, record.worktreeId, removedHostId, survivors)(evidence),
        removedHostId,
        survivors
      )
    ) {
      doomedPaneKeys.push(paneKey)
    }
  }
  return omitSleepingAgentSessionsForWorktrees(state, new Set(), doomedPaneKeys)
}

/**
 * Closes only the removed host's twin state; the survivor's tabs, files and drafts stay. Merges
 * the pre-call snapshot, which survives the announcement's refresh, with tabs opened meanwhile.
 */
export function closeRemovedHostTwinState(
  get: () => AppState,
  set: (patch: (state: AppState) => Partial<AppState>) => void,
  twinHostIds: ReadonlyMap<string, readonly ExecutionHostId[]>,
  beforeCall: RemovedHostTwinState,
  removedHostId: ExecutionHostId
): void {
  const twinWorktreeIds = new Set(twinHostIds.keys())
  const removed = mergeRemovedHostTwinState(
    beforeCall,
    collectRemovedHostTwinState(get(), twinWorktreeIds, removedHostId, twinHostIds),
    get()
  )
  const sleepingPatch = omitRemovedHostSleepingSessions(get(), twinHostIds, removedHostId, removed)
  if (Object.keys(sleepingPatch).length > 0) {
    set(() => sleepingPatch)
  }
  const historyPatch = pruneRemovedHostReopenHistory(get(), twinHostIds, removedHostId)
  if (historyPatch) {
    set(() => historyPatch)
  }
  // Why: a runtime host stopped its own shells on removal, so no close is sent back to it.
  const remoteCloseOwnedByHost = isRuntimeHost(removedHostId)
  // Why planned together: the planner keeps a PTY another surviving tab still binds.
  const plans = buildTerminalTabRetirementPlans(get(), [...removed.terminalTabIds])
  // Why batch-wide: the planner may give a PTY's teardown to a tab that only holds it as a hint.
  const liveInBatch = new Set(
    [...removed.terminalTabIds].flatMap((tabId) => get().ptyIdsByTabId[tabId] ?? [])
  )
  const retiredPtyIds = new Set<string>()
  const killedPtyIds = new Set<string>()
  for (const [tabId, plan] of plans) {
    for (const ptyId of [
      ...plan.localOrSshPtyIds,
      ...plan.runtimeTerminals.map((terminal) => terminal.ptyId),
      ...plan.cleanupOnlyPtyIds,
      ...plan.unroutablePtyIds
    ]) {
      retiredPtyIds.add(ptyId)
    }
    if (!remoteCloseOwnedByHost) {
      // Why killed here: the shared id resolves to no single host, so the planner marks this
      // host's PTYs unroutable; attribution already proved they are the removed host's.
      // Only live-indexed PTYs, as before: a parked layout hint may be another host's session id.
      const candidates = [
        ...plan.localOrSshPtyIds,
        ...plan.unroutablePtyIds,
        ...plan.cleanupOnlyPtyIds
      ]
      for (const ptyId of candidates) {
        if (liveInBatch.has(ptyId) && !isRemoteRuntimePtyId(ptyId) && !killedPtyIds.has(ptyId)) {
          killedPtyIds.add(ptyId)
          window.api.pty.kill(ptyId)
        }
      }
    }
    get().closeTab(tabId, {
      reason: 'cleanup',
      captureRecentlyClosed: false,
      remoteCloseOwnedByHost,
      localPtyTeardownOwnedExternally: !remoteCloseOwnedByHost,
      precomputedRetirementPlan: plan
    })
  }
  if (!remoteCloseOwnedByHost) {
    // Why: the tab stays for its surviving pane, but this host's shell in it must not outlive the project.
    for (const ptyId of removed.mixedTabPtyIds) {
      if (!killedPtyIds.has(ptyId) && !isRemoteRuntimePtyId(ptyId)) {
        window.api.pty.kill(ptyId)
      }
    }
  }
  // Why: a parked or restored pane has no exit callback left to clear these; shared PTYs are not in the plans' lists.
  set((state) => ({
    suppressedPtyExitIds: omitRecordKeys(state.suppressedPtyExitIds, retiredPtyIds),
    pendingPaneAccountRestarts: omitRecordKeys(state.pendingPaneAccountRestarts, retiredPtyIds)
  }))
  // Why: a pending chat's tab can already be gone, so its launch is cancelled through the registry.
  cancelStructuredLaunchesForWorktrees(
    new Set(twinHostIds.keys()),
    (worktreeId, hostId) =>
      removedHostCanonicalizer(
        get(),
        worktreeId,
        removedHostId,
        twinHostIds.get(worktreeId) ?? []
      )(hostId) === removedHostId
  )
  for (const fileId of removed.fileIds) {
    // Why: a file the announcement's refresh already dropped would make closeFile reset the focused surface.
    if (get().openFiles.some((file) => file.id === fileId)) {
      get().closeFile(fileId, { captureRecentlyClosed: false })
    }
  }
  for (const browserTabId of removed.browserTabIds) {
    get().closeBrowserTab(browserTabId, { reason: 'cleanup' })
  }
  for (const tabId of removed.otherTabIds) {
    get().closeUnifiedTab(tabId, { preserveWorktreeSelection: true })
  }
}

/** Keeps the three selection fields consistent once the removed host's copy is gone. */
export function twinSelectionPatch(
  state: Pick<
    AppState,
    | 'activeWorktreeId'
    | 'activeWorkspaceExecutionHostId'
    | 'worktreesByRepo'
    | 'detectedWorktreesByRepo'
  >,
  twinHostIds: ReadonlyMap<string, readonly ExecutionHostId[]>,
  removedHostId: ExecutionHostId
): Partial<AppState> {
  // Why: with no surviving twin, the bulk purge owns the selection exactly as before.
  if (twinHostIds.size === 0) {
    return {}
  }
  const selected = state.activeWorkspaceExecutionHostId
  // Why canonicalized: a copy reached through a paired runtime is selected under that runtime's id.
  const candidates = state.activeWorktreeId ? [state.activeWorktreeId] : [...twinHostIds.keys()]
  const selectsRemovedHost =
    selected === removedHostId ||
    (selected !== null &&
      candidates.some(
        (worktreeId) =>
          twinHostIds.has(worktreeId) &&
          removedHostCanonicalizer(
            state,
            worktreeId,
            removedHostId,
            twinHostIds.get(worktreeId) ?? []
          )(selected) === removedHostId
      ))
  if (!selectsRemovedHost) {
    return {}
  }
  const survivor = state.activeWorktreeId ? twinHostIds.get(state.activeWorktreeId)?.[0] : null
  if (survivor) {
    return { activeWorkspaceExecutionHostId: survivor }
  }
  // Why: a teardown close already deselected the workspace; nothing may still name the removed host.
  return state.activeWorktreeId === null
    ? { activeWorkspaceKey: null, activeWorkspaceExecutionHostId: null }
    : {}
}
