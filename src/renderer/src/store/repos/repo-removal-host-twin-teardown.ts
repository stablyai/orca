import type { AppState } from '../types'
import type { CodexAccountRestart } from '../terminals/terminal-contracts'
import {
  codexAccountRestartToken,
  codexRestartTabIndex,
  isCodexAccountRestart,
  isCurrentCodexAccountRestart
} from '../terminals/codex-account-restart-continuation'
import { getTerminalNoticeLifetime } from '@/components/terminal-pane/provider-notices/terminal-notice-lifetime'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { EditorBufferKeepRequest } from '../slices/editor/buffers/editor-buffer-kept'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { buildTerminalTabRetirementPlans } from '../terminals/retirement/terminal-tab-retirement'
import { cancelStructuredLaunchesForWorktrees } from '../slices/worktrees/teardown/purged-structured-launch-retirement'
import { collectHostTwinPurgeScopes } from '../slices/worktrees/teardown/host-twin-purge-scopes'
import { omitRecordKeys } from '../slices/worktrees/teardown/record-key-omission'
import { removeWorkspaceUnreadState } from '../slices/workspace-attention/workspace-unread-removal'
import { releaseRetiredAccountRestartSlots } from '@/components/terminal-pane/account-restart/detached/detached-pane-restart-slots'
import {
  collectRemovedHostTwinState,
  isRuntimeHost,
  removedHostCanonicalizer,
  type RemovedHostTwinState
} from './repo-removal-host-twin-attribution'

type MixedAccountRestart = Pick<
  CodexAccountRestart,
  | 'requestId'
  | 'attemptId'
  | 'executorId'
  | 'worktreeId'
  | 'tabId'
  | 'tabCreatedAt'
  | 'leafId'
  | 'hostId'
  | 'hostEpoch'
  | 'environmentId'
  | 'pairingRevision'
  | 'runtimeId'
  | 'oldPtyId'
  | 'oldIncarnationId'
  | 'resultPtyId'
  | 'resultIncarnationId'
>

function captureMixedAccountRestarts(
  state: AppState,
  hostId: ExecutionHostId,
  removed: RemovedHostTwinState
): ReadonlyMap<string, MixedAccountRestart> {
  if (removed.mixedTabPtyIds.size === 0) {
    return new Map()
  }
  const candidates = Object.entries(state.pendingPaneAccountRestarts ?? {}).filter(
    ([key, r]) =>
      isCodexAccountRestart(r) &&
      r.hostId === hostId &&
      r.leafId &&
      codexAccountRestartToken(r).key === key &&
      removed.mixedTabPtyIds.has(r.oldPtyId)
  )
  const captured = new Map<string, MixedAccountRestart>()
  const tabs = candidates.length ? codexRestartTabIndex(state) : undefined
  for (const [key, r] of candidates) {
    if (
      !isCodexAccountRestart(r) ||
      !r.leafId ||
      !isCurrentCodexAccountRestart(state, r, tabs) ||
      state.terminalLayoutsByTabId[r.tabId]?.ptyIdsByLeafId?.[r.leafId] !== r.oldPtyId
    ) {
      continue
    }
    captured.set(key, {
      requestId: r.requestId,
      attemptId: r.attemptId,
      executorId: r.executorId,
      worktreeId: r.worktreeId,
      tabId: r.tabId,
      tabCreatedAt: r.tabCreatedAt,
      leafId: r.leafId,
      hostId: r.hostId,
      hostEpoch: r.hostEpoch,
      environmentId: r.environmentId,
      pairingRevision: r.pairingRevision,
      runtimeId: r.runtimeId,
      oldPtyId: r.oldPtyId,
      oldIncarnationId: getTerminalNoticeLifetime(r.oldPtyId)?.incarnationId ?? r.oldIncarnationId,
      resultPtyId: r.resultPtyId,
      resultIncarnationId: r.resultIncarnationId
    })
  }
  return captured
}

function matchesCapturedAccountRestart(
  state: AppState,
  r: CodexAccountRestart,
  captured: MixedAccountRestart | undefined,
  tabs: ReturnType<typeof codexRestartTabIndex> | undefined
): boolean {
  if (
    !captured ||
    !r.leafId ||
    r.requestId !== captured.requestId ||
    r.attemptId !== captured.attemptId ||
    r.executorId !== captured.executorId ||
    r.worktreeId !== captured.worktreeId ||
    r.tabId !== captured.tabId ||
    r.tabCreatedAt !== captured.tabCreatedAt ||
    r.leafId !== captured.leafId ||
    r.hostId !== captured.hostId ||
    r.hostEpoch !== captured.hostEpoch ||
    r.environmentId !== captured.environmentId ||
    r.pairingRevision !== captured.pairingRevision ||
    r.runtimeId !== captured.runtimeId ||
    r.oldPtyId !== captured.oldPtyId ||
    r.resultPtyId !== captured.resultPtyId ||
    r.resultIncarnationId !== captured.resultIncarnationId ||
    (r.oldIncarnationId && r.oldIncarnationId !== captured.oldIncarnationId) ||
    !isCurrentCodexAccountRestart(state, r, tabs)
  ) {
    return false
  }
  const bound = state.terminalLayoutsByTabId[r.tabId]?.ptyIdsByLeafId?.[r.leafId]
  const incarnation = bound ? getTerminalNoticeLifetime(bound)?.incarnationId : undefined
  return (
    !bound ||
    (bound === captured.oldPtyId && (!incarnation || incarnation === captured.oldIncarnationId))
  )
}

export type RemovedHostTwins = {
  /** Twin ids with the hosts that still publish them. */
  twinHostIds: Map<string, ExecutionHostId[]>
  /** Per attributed host (a paired runtime's copy names its SSH host), its surfaces there. */
  byHost: {
    hostId: ExecutionHostId
    /** This host's own twin ids with their survivors. */
    twinHostIds: ReadonlyMap<string, readonly ExecutionHostId[]>
    removed: RemovedHostTwinState
    accountRestarts?: ReadonlyMap<string, MixedAccountRestart>
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
    byHost: scopes.map(([attributedHostId, twins]) => {
      const removed = collectRemovedHostTwinState(
        state,
        new Set(twins.keys()),
        attributedHostId,
        twins
      )
      return {
        hostId: attributedHostId,
        twinHostIds: twins,
        removed,
        accountRestarts: captureMixedAccountRestarts(state, attributedHostId, removed)
      }
    })
  }
}

/** Close attributed surfaces through normal actions; retain unknown/mixed state rather than lose survivor data. File closes keepEditorBuffer so dirty records survive tab removal. */
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
    const captured = preCall.byHost.find((entry) => entry.hostId === hostId)?.accountRestarts
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
    const retiredPtyIds = new Set(removed?.mixedTabPtyIds ?? [])
    for (const [tabId, plan] of plans) {
      for (const ptyId of [
        ...plan.localOrSshPtyIds,
        ...plan.runtimeTerminals.map((terminal) => terminal.ptyId),
        ...plan.cleanupOnlyPtyIds,
        ...plan.unroutablePtyIds
      ]) {
        retiredPtyIds.add(ptyId)
      }
      // Planner cannot route shared raw IDs; attribution already proves these unroutable PTYs belong to the removed host.
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
    const beforeRestarts = get().pendingPaneAccountRestarts
    set((state) => {
      const tabs = captured?.size ? codexRestartTabIndex(state) : undefined
      return {
        ...removeWorkspaceUnreadState(
          state,
          [
            ...new Set([
              ...hostTwinIds.keys(),
              ...preCall.byHost
                .filter((entry) => entry.hostId === hostId)
                .flatMap((entry) => [...entry.twinHostIds.keys()])
            ])
          ].map((id) => ({ id, hostId }))
        ),
        suppressedPtyExitIds: omitRecordKeys(state.suppressedPtyExitIds, retiredPtyIds),
        pendingPaneAccountRestarts: Object.fromEntries(
          Object.entries(state.pendingPaneAccountRestarts).filter(([key, request]) =>
            typeof request === 'string'
              ? !retiredPtyIds.has(key)
              : !(
                  request.hostId === hostId &&
                  (terminalTabIds.has(request.tabId) ||
                    retiredPtyIds.has(request.oldPtyId) ||
                    (isCodexAccountRestart(request) &&
                      request.resultPtyId !== undefined &&
                      retiredPtyIds.has(request.resultPtyId)) ||
                    (isCodexAccountRestart(request) &&
                      matchesCapturedAccountRestart(state, request, captured?.get(key), tabs)))
                )
          )
        ),
        codexRestartNoticeByPtyId: omitRecordKeys(state.codexRestartNoticeByPtyId, retiredPtyIds)
      }
    })
    releaseRetiredAccountRestartSlots(beforeRestarts, get().pendingPaneAccountRestarts)
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
