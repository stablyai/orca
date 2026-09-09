import { applyHostWorktreeTerminalSleepState } from '@/components/terminal-pane/pty-shutdown-exit-deferral'
import { dispatchTerminalSideEffectBatch } from '@/components/terminal-pane/terminal-side-effect-facts-handler'
import { emitAutomationsChangedWindowEvent } from '@/lib/automations-changed-window-event'
import { applyNativeChatLaunchDraftResolved } from '@/runtime/native-chat-launch-draft-runtime-resolution'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import {
  applyRuntimeEnvironmentSshStateChanged,
  hydrateRuntimeEnvironmentSshState,
  refreshRuntimeEnvironmentSshTargetMetadata
} from '@/runtime/runtime-environment-ssh-state'
import { subscribeRuntimeClientEvents } from '@/runtime/runtime-client-events'
import { toRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import { getEnvironmentSshStateGeneration } from '@/store/slices/runtime-environment-ssh'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import { useAppStore } from '../../store'
import { createRuntimeClientEventsSync } from '../runtime-client-events-sync'
import {
  createRuntimeProjectRefreshScheduler,
  refreshRuntimeProjectWorktreesAndLineage
} from '../runtime-project-refresh-scheduler'
import {
  buildRuntimeClientEventEnvironmentKey,
  createRuntimeEnvironmentStoreSyncSubscriber,
  getReachableRuntimeEnvironmentIds,
  getRuntimeClientEventEnvironmentIds,
  invalidateRuntimeClientEventReplay
} from './runtime-environment-subscription-selection'
import type { WorktreeEventRuntime } from './worktree-event-runtime'

/** Backoff for re-asking status.get after a probe that failed on its own socket. */
const RUNTIME_STATUS_PROBE_RETRY_DELAYS_MS = [2_000, 10_000]

/**
 * Why a request carries its reason: `reconnected` must re-ask even when the cache reads
 * reachable (a restart changes the runtimeId under an unchanged-looking status), while
 * `recordedUnreachable` is satisfied by any answer that clears the offline verdict.
 */
type RuntimeStatusProbeTrigger = 'reconnected' | 'recordedUnreachable'

function isRuntimeStatusRecordedUnreachable(environmentId: string): boolean {
  return useAppStore.getState().runtimeStatusByEnvironmentId?.get(environmentId)?.status === null
}

export function registerRuntimeClientIpcBridge(
  unsubs: (() => void)[],
  worktreeRuntime: WorktreeEventRuntime
): () => void {
  const { worktreeChangeRefreshQueue, activateNotifiedWorktree } = worktreeRuntime
  const ensureRuntimeEventRepoKnown = async (
    environmentId: string,
    repoId: string
  ): Promise<void> => {
    if ((useAppStore.getState().repos ?? []).some((repo) => repo.id === repoId)) {
      return
    }
    await useAppStore.getState().fetchRuntimeEnvironmentRepos(environmentId)
  }

  const runtimeProjectRefreshScheduler = createRuntimeProjectRefreshScheduler({
    refresh: async (environmentId) => {
      // Why: project events can reveal target CRUD, but known target states already arrive by push.
      void refreshRuntimeEnvironmentSshTargetMetadata(environmentId).catch(() => {})
      const repos = await useAppStore.getState().fetchRuntimeEnvironmentRepos(environmentId)
      // Why: the host emits one reposChanged for group/folder-workspace edits too, so those
      // catalogs go stale without this; groups first because folder workspaces resolve owners from them.
      const runtimeOwner = { runtimeEnvironmentId: environmentId }
      // Why: catalogs and worktrees are independent; serializing them put two 15s RPC
      // timeouts ahead of worktree/lineage convergence on a wedged host.
      await Promise.all([
        (async () => {
          await useAppStore.getState().fetchProjectGroups(runtimeOwner)
          await useAppStore.getState().fetchFolderWorkspaces(runtimeOwner)
        })(),
        refreshRuntimeProjectWorktreesAndLineage(
          environmentId,
          repos,
          (repoId, options) => useAppStore.getState().fetchWorktrees(repoId, options),
          (options) => useAppStore.getState().fetchWorktreeLineage(options)
        )
      ])
    },
    onError: (error) => {
      console.error('Failed to refresh runtime projects:', error)
    }
  })

  const handleRuntimeClientEvent = (
    environmentId: string,
    event: RuntimeClientEvent,
    generation = getEnvironmentSshStateGeneration(environmentId)
  ): void => {
    if (event.type === 'worktreeTerminalSleepState') {
      applyHostWorktreeTerminalSleepState(environmentId, event)
      return
    }
    if (event.type === 'terminalSideEffects') {
      dispatchTerminalSideEffectBatch({
        ...event.batch,
        ptyId: toRemoteRuntimePtyId(event.batch.ptyId, environmentId)
      })
      return
    }
    if (event.type === 'nativeChatLaunchDraftResolved') {
      applyNativeChatLaunchDraftResolved(useAppStore.getState(), event)
      return
    }
    if (event.type === 'reposChanged') {
      runtimeProjectRefreshScheduler.request(environmentId)
      return
    }
    if (event.type === 'automationsChanged') {
      // Why: without the environment the subscriber cannot attribute the changed authority.
      emitAutomationsChangedWindowEvent({
        environmentId,
        ...(event.selector ? { selector: event.selector } : {}),
        ...(event.reason ? { reason: event.reason } : {})
      })
      return
    }
    if (event.type === 'sshStateChanged') {
      applyRuntimeEnvironmentSshStateChanged(environmentId, event.targetId, event.state, generation)
      return
    }
    if (event.type === 'worktreesChanged') {
      void ensureRuntimeEventRepoKnown(environmentId, event.repoId).then(() =>
        worktreeChangeRefreshQueue.enqueue({
          repoId: event.repoId,
          executionHostId: toRuntimeExecutionHostId(environmentId)
        })
      )
      return
    }
    if (event.type === 'linearLinkedIssueUpdated') {
      void useAppStore
        .getState()
        .refreshLinearIssue(event.identifier, event.workspaceId)
        .catch((error) => {
          console.error('Failed to refresh updated Linear issue:', error)
        })
      return
    }
    void ensureRuntimeEventRepoKnown(environmentId, event.repoId)
      .then(() => activateNotifiedWorktree(event, { allowRuntimeEnvironment: true }))
      .catch((error) => {
        console.error('Failed to activate runtime-created worktree:', error)
      })
  }

  const inFlightRuntimeStatusProbes = new Set<string>()
  const trailingRuntimeStatusProbes = new Map<string, RuntimeStatusProbeTrigger>()
  const runtimeStatusProbeRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let runtimeStatusProbesStopped = false
  // Why not the desired-subscription set alone: a host that is not the active environment
  // drops out of it the moment anything records its status unreachable, so gating the
  // retry on it cancels the retry exactly where recovery matters. Only removal
  // (or a still-unhydrated catalog behind an active id) decides whether to keep asking,
  // and the tombstone covers the window where settings still names a deleted host active.
  const shouldProbeRuntimeStatus = (environmentId: string): boolean => {
    const state = useAppStore.getState()
    if (state.removedRuntimeEnvironmentIds?.has(environmentId)) {
      return false
    }
    return (
      (state.runtimeEnvironments ?? []).some((environment) => environment.id === environmentId) ||
      getRuntimeClientEventEnvironmentIds(state).includes(environmentId)
    )
  }
  // Why: concurrent probes resolve in arbitrary order, so a slow one can publish its
  // stale answer over a newer one and leave the sidebar naming a superseded runtime.
  const probeRuntimeStatus = (
    environmentId: string,
    attempt = 0,
    trigger: RuntimeStatusProbeTrigger = 'reconnected'
  ): void => {
    if (runtimeStatusProbesStopped || !shouldProbeRuntimeStatus(environmentId)) {
      return
    }
    if (inFlightRuntimeStatusProbes.has(environmentId)) {
      // Serialize, don't drop: the in-flight answer predates this request, so a reconnect
      // that lands mid-probe would otherwise go unasked — and a probe that succeeds
      // schedules no retry to pick it up later. A reconnect outranks a queued
      // recorded-unreachable request, which the in-flight answer may already settle.
      if (trigger === 'reconnected' || !trailingRuntimeStatusProbes.has(environmentId)) {
        trailingRuntimeStatusProbes.set(environmentId, trigger)
      }
      return
    }
    const pendingRetry = runtimeStatusProbeRetryTimers.get(environmentId)
    if (pendingRetry !== undefined) {
      clearTimeout(pendingRetry)
      runtimeStatusProbeRetryTimers.delete(environmentId)
    }
    inFlightRuntimeStatusProbes.add(environmentId)
    void useAppStore
      .getState()
      // publishUnreachable: false — the transport that just proved this host alive is not the
      // socket status.get dials, so a failed probe here is unverifiable and must publish nothing.
      .refreshRuntimeEnvironmentStatus(environmentId, undefined, { publishUnreachable: false })
      .catch(() => false)
      .then((reachable) => {
        inFlightRuntimeStatusProbes.delete(environmentId)
        const trailingTrigger = trailingRuntimeStatusProbes.get(environmentId)
        if (trailingTrigger !== undefined) {
          trailingRuntimeStatusProbes.delete(environmentId)
          // A newer reconnect asked while this one was dialing: restart the attempt chain.
          // A resubscribe only asked because the cache read unreachable, so skip the extra
          // socket + E2EE handshake when this answer already cleared that.
          if (
            trailingTrigger === 'reconnected' ||
            isRuntimeStatusRecordedUnreachable(environmentId)
          ) {
            probeRuntimeStatus(environmentId, 0, trailingTrigger)
            return
          }
        }
        // Why: status.get dials its own short-lived socket, so it can fail while the
        // control transport that just proved the host is up stays healthy. That failure
        // is unverifiable and publishes nothing, so no store transition, resubscribe or
        // further trigger follows — without this bounded retry one unlucky probe leaves
        // a host already recorded offline stranded until the next transport gap.
        const retryDelayMs = RUNTIME_STATUS_PROBE_RETRY_DELAYS_MS[attempt]
        if (
          reachable ||
          retryDelayMs === undefined ||
          runtimeStatusProbesStopped ||
          !shouldProbeRuntimeStatus(environmentId)
        ) {
          return
        }
        runtimeStatusProbeRetryTimers.set(
          environmentId,
          setTimeout(() => {
            runtimeStatusProbeRetryTimers.delete(environmentId)
            probeRuntimeStatus(environmentId, attempt + 1)
          }, retryDelayMs)
        )
      })
  }
  unsubs.push(() => {
    // The flag, not just the timers: a probe still in flight at teardown would
    // otherwise schedule a fresh retry chain after the bridge is gone.
    runtimeStatusProbesStopped = true
    trailingRuntimeStatusProbes.clear()
    for (const retryTimer of runtimeStatusProbeRetryTimers.values()) {
      clearTimeout(retryTimer)
    }
    runtimeStatusProbeRetryTimers.clear()
  })

  const runtimeClientEventsSync = createRuntimeClientEventsSync({
    getDesiredEnvironmentIds: () => getRuntimeClientEventEnvironmentIds(useAppStore.getState()),
    getSubscriptionKey: (environmentId) => buildRuntimeClientEventEnvironmentKey([environmentId]),
    subscribe: (environmentId, onEvent, onError) => {
      const sshGeneration = getEnvironmentSshStateGeneration(environmentId)
      const runtimeGeneration = getRuntimeEnvironmentConnectionGeneration(environmentId)
      const runtimeRevision = getRuntimeEnvironmentRevision(environmentId)
      const subscription = subscribeRuntimeClientEvents(
        environmentId,
        (event) => {
          if (
            sshGeneration === getEnvironmentSshStateGeneration(environmentId) &&
            runtimeGeneration === getRuntimeEnvironmentConnectionGeneration(environmentId) &&
            runtimeRevision === getRuntimeEnvironmentRevision(environmentId)
          ) {
            onEvent(event)
          }
        },
        onError,
        () => {
          invalidateRuntimeClientEventReplay({
            getSshStateReference: () => useAppStore.getState().sshStateByEnvironment,
            refreshRuntimeStatus: () => probeRuntimeStatus(environmentId),
            requestProjectRefresh: () => runtimeProjectRefreshScheduler.request(environmentId),
            markEnvironmentSshStateStale: () =>
              useAppStore.getState().markEnvironmentSshStateStale(environmentId),
            hydrateEnvironmentSshState: () =>
              hydrateRuntimeEnvironmentSshState(environmentId, { force: true }),
            sync: runtimeClientEventsSync.sync
          })
        }
      )
      // Why: only a reconnect of an already-ready transport replays with the tag above.
      // A connection whose first ready lands after the host recovered (app started, or
      // the env was added, while it was down) never replays, so the recorded-unreachable
      // verdict this subscribe just disproved has to be re-asked here. Kept off the
      // returned promise so subscription registration/teardown ordering is unchanged.
      void subscription.then(
        () => {
          if (isRuntimeStatusRecordedUnreachable(environmentId)) {
            probeRuntimeStatus(environmentId, 0, 'recordedUnreachable')
          }
        },
        () => {}
      )
      return subscription
    },
    onEvent: handleRuntimeClientEvent
  })

  // Why: no on-connect repo fetch (PR #2); seed discovery for connected runtimes or remote projects hide until Add-Project.
  const initialRuntimeEnvironmentState = useAppStore.getState()
  const runtimeClientEventEnvironmentIds = getRuntimeClientEventEnvironmentIds(
    initialRuntimeEnvironmentState
  )
  for (const environmentId of runtimeClientEventEnvironmentIds) {
    runtimeProjectRefreshScheduler.request(environmentId)
  }
  const reachableRuntimeEnvironmentIds = getReachableRuntimeEnvironmentIds(
    initialRuntimeEnvironmentState
  )
  const handleRuntimeEnvironmentStoreWrite = createRuntimeEnvironmentStoreSyncSubscriber({
    initialDesiredEnvironmentIds: runtimeClientEventEnvironmentIds,
    initialReachableEnvironmentIds: reachableRuntimeEnvironmentIds,
    buildEnvironmentKey: buildRuntimeClientEventEnvironmentKey,
    getDesiredEnvironmentIds: getRuntimeClientEventEnvironmentIds,
    getReachableEnvironmentIds: getReachableRuntimeEnvironmentIds,
    requestProjectRefresh: (environmentId) =>
      // The scheduler coalesces bursts per environment.
      runtimeProjectRefreshScheduler.request(environmentId),
    markEnvironmentSshStateStale: (environmentId) => {
      // No-op when the environment has no SSH bucket (e.g. web client).
      useAppStore.getState().markEnvironmentSshStateStale(environmentId)
    },
    sync: runtimeClientEventsSync.sync
  })
  const unsubscribeRuntimeEnvironmentStore = useAppStore.subscribe(
    handleRuntimeEnvironmentStoreWrite
  )
  // Subscribe before the first runtime stream starts: replay invalidation may
  // synchronously publish a tracked SSH bucket and relies on this listener to
  // replace that subscription exactly once.
  runtimeClientEventsSync.sync()
  unsubs.push(runtimeClientEventsSync.stop)
  unsubs.push(runtimeProjectRefreshScheduler.stop)

  return unsubscribeRuntimeEnvironmentStore
}
