import type { AppState } from '../types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { EditorBufferKeepRequest } from '../slices/editor/buffers/editor-buffer-kept'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { buildTerminalTabRetirementPlans } from '../slices/terminal-tab-retirement'
import { cancelStructuredLaunchesForWorktrees } from '../slices/worktrees/teardown/purged-structured-launch-retirement'
import { collectHostTwinPurgeScopes } from '../slices/worktrees/teardown/host-twin-worktree-purge'
import { omitRecordKeys } from '../slices/worktrees/teardown/record-key-omission'
import {
  collectRemovedHostTwinState,
  isRuntimeHost,
  removedHostCanonicalizer,
  type RemovedHostTwinState
} from './repo-removal-host-twin-attribution'

export type RemovedHostTwins = {
  /** Twin ids with the hosts that still publish them. */
  twinHostIds: Map<string, ExecutionHostId[]>
  /** Per attributed host (a paired runtime's copy names its SSH host), its surfaces there. */
  byHost: {
    hostId: ExecutionHostId
    /** This host's own twin ids with their survivors. */
    twinHostIds: ReadonlyMap<string, readonly ExecutionHostId[]>
    removed: RemovedHostTwinState
  }[]
}

/** The removed copy's ids that another host still publishes, matched as the purge matches them. */
export function collectRemovedHostTwins(
  state: AppState,
  worktreeIds: readonly string[],
  hostId: ExecutionHostId
): RemovedHostTwins {
  const scopes = [
    ...collectHostTwinPurgeScopes(
      state,
      worktreeIds.map((id) => ({ id, hostId }))
    )
  ]
  return {
    twinHostIds: new Map(scopes.flatMap(([, twins]) => [...twins])),
    byHost: scopes.map(([attributedHostId, twins]) => ({
      hostId: attributedHostId,
      twinHostIds: twins,
      removed: collectRemovedHostTwinState(state, new Set(twins.keys()), attributedHostId, twins)
    }))
  }
}

/**
 * Closes the surfaces attributed to the removed copy through their close actions, so chats,
 * previews and shells retire as on any close. Anything unattributed (mixed tabs, reopen history,
 * tabless sleeping records) stays: a stale entry, never the survivor's data lost. Each file close
 * carries `keepEditorBuffer`, so a dirty record it closes outlives the tab.
 */
export function closeRemovedHostTwinState(
  get: () => AppState,
  set: (patch: (state: AppState) => Partial<AppState>) => void,
  twins: RemovedHostTwins,
  preCall: RemovedHostTwins,
  keepEditorBuffer?: EditorBufferKeepRequest
): void {
  const state = get()
  const presentTabIds = new Set([
    ...Object.values(state.tabsByWorktree).flatMap((tabs) => tabs.map((tab) => tab.id)),
    ...Object.values(state.unifiedTabsByWorktree).flatMap((tabs) => tabs.map((tab) => tab.entityId))
  ])
  // Why pre-call hosts too: a concurrent removal of the other copy can leave no twin to rescan.
  for (const hostId of new Set([...twins.byHost, ...preCall.byHost].map((entry) => entry.hostId))) {
    const current = twins.byHost.find((entry) => entry.hostId === hostId)
    const removed = current?.removed
    // Why this host's ids only: another attributed host's survivor may be this host.
    const hostTwinIds = current?.twinHostIds ?? new Map<string, readonly ExecutionHostId[]>()
    // Why: a host frame during the call can drop a tab without closeTab's agent and cache cleanup.
    const terminalTabIds = new Set([
      ...(removed?.terminalTabIds ?? []),
      ...preCall.byHost
        .filter((entry) => entry.hostId === hostId)
        .flatMap((entry) => [...entry.removed.terminalTabIds])
        .filter((tabId) => !presentTabIds.has(tabId))
    ])
    // Why: a runtime host stopped its own shells on removal, so no close is sent back to it.
    const remoteCloseOwnedByHost = isRuntimeHost(hostId)
    // Why planned together: the planner keeps a PTY another surviving tab still binds.
    const plans = buildTerminalTabRetirementPlans(get(), [...terminalTabIds])
    // Why live-indexed only: a parked layout hint may be another host's session id.
    const liveInBatch = new Set(
      [...terminalTabIds].flatMap((tabId) => get().ptyIdsByTabId[tabId] ?? [])
    )
    const killedPtyIds = new Set<string>()
    const retiredPtyIds = new Set<string>()
    for (const [tabId, plan] of plans) {
      for (const ptyId of [
        ...plan.localOrSshPtyIds,
        ...plan.runtimeTerminals.map((terminal) => terminal.ptyId),
        ...plan.cleanupOnlyPtyIds,
        ...plan.unroutablePtyIds
      ]) {
        retiredPtyIds.add(ptyId)
      }
      // Why killed here: the shared id resolves to no single host, so the planner marks this
      // host's PTYs unroutable; attribution already proved they are the removed host's.
      const candidates = remoteCloseOwnedByHost
        ? []
        : [...plan.localOrSshPtyIds, ...plan.unroutablePtyIds, ...plan.cleanupOnlyPtyIds]
      for (const ptyId of candidates) {
        if (liveInBatch.has(ptyId) && !isRemoteRuntimePtyId(ptyId) && !killedPtyIds.has(ptyId)) {
          killedPtyIds.add(ptyId)
          window.api.pty.kill(ptyId)
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
    // Why: the tab stays for its surviving pane, but this host's shell in it must not outlive the project.
    for (const ptyId of remoteCloseOwnedByHost ? [] : (removed?.mixedTabPtyIds ?? [])) {
      if (!killedPtyIds.has(ptyId) && !isRemoteRuntimePtyId(ptyId)) {
        window.api.pty.kill(ptyId)
      }
    }
    // Why: a parked or restored pane has no exit callback left to clear these; shared PTYs are not in the plans' lists.
    set((state) => ({
      suppressedPtyExitIds: omitRecordKeys(state.suppressedPtyExitIds, retiredPtyIds),
      pendingPaneAccountRestarts: omitRecordKeys(state.pendingPaneAccountRestarts, retiredPtyIds),
      codexRestartNoticeByPtyId: omitRecordKeys(state.codexRestartNoticeByPtyId, retiredPtyIds)
    }))
    // Why: a pending chat's tab can already be gone, so its launch is cancelled through the registry.
    cancelStructuredLaunchesForWorktrees(
      new Set(hostTwinIds.keys()),
      (worktreeId, launchHostId) =>
        removedHostCanonicalizer(
          get(),
          worktreeId,
          hostId,
          hostTwinIds.get(worktreeId) ?? []
        )(launchHostId) === hostId
    )
    for (const fileId of removed?.fileIds ?? []) {
      // Why: a file a listing refresh already dropped would make closeFile reset the focused surface.
      if (get().openFiles.some((file) => file.id === fileId)) {
        get().closeFile(fileId, { captureRecentlyClosed: false, keepEditorBuffer })
      }
    }
    for (const browserTabId of removed?.browserTabIds ?? []) {
      get().closeBrowserTab(browserTabId, { reason: 'cleanup' })
    }
    for (const tabId of removed?.otherTabIds ?? []) {
      get().closeUnifiedTab(tabId, { preserveWorktreeSelection: true })
    }
  }
}
