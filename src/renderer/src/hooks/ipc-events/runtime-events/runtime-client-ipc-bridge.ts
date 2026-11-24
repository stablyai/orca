import {
  registerLinearLinkedIssueRefresh,
  refreshDefaultLinkedLinearIssue
} from '../../../lib/work-items/linear/linear-linked-issue-refresh'
import { dispatchTerminalSideEffectBatch } from '@/components/terminal-pane/pty-transport/output/terminal-side-effect-facts-handler'
import { emitPairedBotsChanged, emitPairedBotsStreamCameBack } from '@/lib/bot-host-listing'
import { readBotChangeScopeWithItems } from '../../../../../shared/bots/bot-change-scope'
import { emitRuntimeClientWindowEvent } from './runtime-client-window-events'
import { applyHostWorkspaceRowEvent } from '../workspace-catalog/worktree-metadata-set-events'
import { applyNativeChatLaunchDraftResolved } from '@/runtime/native-chat/launch-drafts/native-chat-launch-draft-runtime-resolution'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import {
  refreshRuntimeEnvironmentCatalog,
  setRuntimeEnvironmentCatalogRefresher
} from '@/runtime/rpc/environment-revisions/runtime-environment-pairing-refresh'
import {
  applyRuntimeEnvironmentSshStateChanged,
  hydrateRuntimeEnvironmentSshState
} from '@/runtime/hosts/ssh/runtime-environment-ssh-state'
import { subscribeRuntimeClientEvents } from '@/runtime/rpc/subscriptions/runtime-client-events'
import { hostsBrowserPagesFor } from '@/runtime/browser/client-hosting/browser-client-host-request-answer'
import { toRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { getEnvironmentSshStateGeneration } from '@/store/slices/ssh/runtime-environment-ssh'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status/runtime-status-connection-generation'
import {
  getRepoExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import type { RuntimeClientEvent } from '../../../../../shared/remote-runtime/session-graph/runtime-client-events'
import { navigationTargetsClients } from '../../../../../shared/remote-runtime/session-graph/runtime-navigation'
import {
  readRuntimeStatuses,
  subscribeAppStoreWithStatuses
} from '@/store/slices/runtime-status/views/runtime-status-owner'
import { useAppStore } from '../../../store/index'
import { invalidateRemoteWorktreeLineage } from '../../../store/slices/worktrees/metadata/worktree-lineage-readiness'
import {
  adoptFromEndpoint,
  type OwnedWorktreeEvent
} from '../../../store/host-catalog/endpoint-catalog-adoption'
import { createRuntimeClientEventsSync } from './runtime-client-events-sync'
import { createRuntimeProjectCatalogRefreshScheduler } from '../workspace-catalog/runtime-project-catalog-refresh'
import {
  buildRuntimeClientEventEnvironmentKey,
  createRuntimeEnvironmentStoreSyncSubscriber,
  getReachableRuntimeEnvironmentIds,
  getRuntimeClientEventEnvironmentIds,
  invalidateRuntimeClientEventReplay,
  pickRuntimeEnvironmentSyncState,
  runtimeEnvironmentSyncWrites
} from './runtime-environment-subscription-selection'
import type { WorktreeEventRuntime } from '../workspace-catalog/worktree-event-runtime'
import { noteOrchestrationSessionWorkersChanged } from '@/lib/orchestration-session-workers'
import { readPublishedSortOrders } from '../../../store/slices/worktrees/listing/worktree-sort-order-patch'

const readSyncState = () =>
  pickRuntimeEnvironmentSyncState(useAppStore.getState(), readRuntimeStatuses())

export function registerRuntimeClientIpcBridge(
  unsubs: (() => void)[],
  worktreeRuntime: WorktreeEventRuntime
): () => void {
  const { worktreeChangeRefreshQueue, activateNotifiedWorktree } = worktreeRuntime
  const linearRefresh = registerLinearLinkedIssueRefresh(unsubs)
  let stopped = false
  unsubs.push(() => {
    stopped = true
  })
  const isRuntimeEventRepoKnown = ({ repoId, executionHostId }: OwnedWorktreeEvent): boolean =>
    (useAppStore.getState().repos ?? []).some(
      (repo) => repo.id === repoId && getRepoExecutionHostId(repo) === executionHostId
    )
  const ensureRuntimeEventRepoKnown = async (
    environmentId: string,
    event: OwnedWorktreeEvent
  ): Promise<void> => {
    if (isRuntimeEventRepoKnown(event)) {
      return
    }
    await useAppStore.getState().fetchRuntimeEnvironmentRepos(environmentId)
  }

  const runtimeProjectRefreshScheduler = createRuntimeProjectCatalogRefreshScheduler()
  const requestProjectRefresh = (environmentId: string): void => {
    invalidateRemoteWorktreeLineage(useAppStore.getState, environmentId)
    runtimeProjectRefreshScheduler.request(environmentId)
  }

  const handleRuntimeClientEvent = (
    environmentId: string,
    event: RuntimeClientEvent,
    generation = getEnvironmentSshStateGeneration(environmentId)
  ): void => {
    if (event.type === 'notificationAttentionAcknowledged') {
      void window.api.notifications
        .acknowledgeAttention(event.acknowledgement, toRuntimeExecutionHostId(environmentId))
        .catch((error: unknown) =>
          console.warn('[notifications] Remote acknowledgement failed', error)
        )
      return
    }
    if (applyHostWorkspaceRowEvent(environmentId, event)) {
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
    // A paired desktop keeps its own Workspace options; it reads only the host's columns, for the host's cards.
    if (event.type === 'workspaceViewChanged') {
      void useAppStore.getState().fetchHostWorkspaceStatuses(environmentId)
      return
    }
    if (event.type === 'reposChanged') {
      requestProjectRefresh(environmentId)
      return
    }
    if (event.type === 'agentCliUpdateFinished') {
      useAppStore.getState().recheckAgentCliUpdates({ kind: 'environment', environmentId })
      return
    }
    if (emitRuntimeClientWindowEvent(environmentId, event)) {
      return
    }
    if (event.type === 'botsChanged') {
      emitPairedBotsChanged(environmentId, readBotChangeScopeWithItems(event))
      return
    }
    if (event.type === 'orchestrationSessionWorkersChanged') {
      noteOrchestrationSessionWorkersChanged(environmentId, event.sessionId)
      return
    }
    if (event.type === 'browserProfilesChanged') {
      void useAppStore
        .getState()
        .fetchBrowserSessionProfiles(toRuntimeExecutionHostId(environmentId))
      return
    }
    if (event.type === 'sshStateChanged') {
      applyRuntimeEnvironmentSshStateChanged(environmentId, event.targetId, event.state, generation)
      return
    }
    const endpoint = { kind: 'environment' as const, environmentId }
    if (event.type === 'worktreesChanged') {
      if (event.sortOrderOnly !== true) {
        invalidateRemoteWorktreeLineage(useAppStore.getState, environmentId)
      }
      const owned = adoptFromEndpoint(endpoint, {
        kind: 'worktreeEvent',
        row: {
          repoId: event.repoId,
          ...(event.sortOrderOnly === true ? { sortOrderOnly: true } : {})
        }
      })
      const sortOrders =
        event.sortOrderOnly === true ? readPublishedSortOrders(event.sortOrders) : null
      if (sortOrders && isRuntimeEventRepoKnown(owned)) {
        // Why sync: published values must enqueue in receipt order; an unknown repo refetches instead.
        worktreeChangeRefreshQueue.enqueue({ ...owned, sortOrders })
        return
      }
      void ensureRuntimeEventRepoKnown(environmentId, owned).then(() =>
        worktreeChangeRefreshQueue.enqueue(owned)
      )
      return
    }
    if (event.type === 'linearLinkedIssueUpdated') {
      refreshDefaultLinkedLinearIssue(event)
      linearRefresh.handle(endpoint, event)
      return
    }
    // This window builds its sidebar from its own store, never from a host's phone feed.
    if (event.type === 'sidebarInputsChanged') {
      return
    }
    if (event.type !== 'activateWorktree') {
      return
    }
    // Older hosts broadcast local/CLI activation without an address; that is not this viewer's intent.
    if (!event.navigation || !navigationTargetsClients(event.navigation)) {
      return
    }
    const runtimeGeneration = getRuntimeEnvironmentConnectionGeneration(environmentId)
    const runtimeRevision = getRuntimeEnvironmentRevision(environmentId)
    const isCurrent = (): boolean =>
      !stopped &&
      generation === getEnvironmentSshStateGeneration(environmentId) &&
      runtimeGeneration === getRuntimeEnvironmentConnectionGeneration(environmentId) &&
      runtimeRevision === getRuntimeEnvironmentRevision(environmentId)
    const owned = adoptFromEndpoint(endpoint, {
      kind: 'worktreeEvent',
      row: { repoId: event.repoId }
    })
    void ensureRuntimeEventRepoKnown(environmentId, owned)
      .then(() => {
        return isCurrent()
          ? activateNotifiedWorktree(event, {
              allowRuntimeEnvironment: true,
              executionHostId: owned.executionHostId,
              isCurrent
            })
          : undefined
      })
      .catch((error) => {
        console.error('Failed to activate runtime-created worktree:', error)
      })
  }

  setRuntimeEnvironmentCatalogRefresher(async () => {
    const environments = await window.api.runtimeEnvironments.list()
    useAppStore.getState().setRuntimeEnvironments(environments)
    return environments
  })
  unsubs.push(() => setRuntimeEnvironmentCatalogRefresher(null))
  // `orca environment add/rm` edits the registry without any renderer request (#25251).
  const stopCatalogChanged = window.api.runtimeEnvironments?.onCatalogChanged?.(() => {
    void refreshRuntimeEnvironmentCatalog()
  })
  if (stopCatalogChanged) {
    unsubs.push(stopCatalogChanged)
  }
  const runtimeClientEventsSync = createRuntimeClientEventsSync({
    getDesiredEnvironmentIds: () => getRuntimeClientEventEnvironmentIds(readSyncState()),
    getSubscriptionKey: (environmentId) => buildRuntimeClientEventEnvironmentKey([environmentId]),
    subscribe: (environmentId, onEvent, onError, isCurrent, onClose) => {
      const sshGeneration = getEnvironmentSshStateGeneration(environmentId)
      const runtimeGeneration = getRuntimeEnvironmentConnectionGeneration(environmentId)
      const runtimeRevision = getRuntimeEnvironmentRevision(environmentId)
      void useAppStore.getState().fetchHostWorkspaceStatuses(environmentId)
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
          if (!isCurrent()) {
            return
          }
          invalidateRuntimeClientEventReplay({
            getSshStateReference: () => useAppStore.getState().sshStateByEnvironment,
            refreshRuntimeStatus: () => {
              const snapshot = readRuntimeStatuses().get(environmentId)?.snapshot
              if (!snapshot || snapshot.transport === 'unknown') {
                void useAppStore.getState().refreshRuntimeEnvironmentStatus(environmentId)
              }
            },
            requestProjectRefresh: () => {
              requestProjectRefresh(environmentId)
              // Changes during the outage were lost, not queued: reads from before prove nothing now.
              emitPairedBotsStreamCameBack(environmentId)
              useAppStore.getState().recheckAgentCliUpdates({ kind: 'environment', environmentId })
            },
            markEnvironmentSshStateStale: () =>
              useAppStore.getState().markEnvironmentSshStateStale(environmentId),
            hydrateEnvironmentSshState: () =>
              hydrateRuntimeEnvironmentSshState(environmentId, { force: true }),
            sync: () => runtimeClientEventsSync.sync([environmentId])
          })
        },
        { hostsBrowserPages: hostsBrowserPagesFor(environmentId), onClose }
      )
      return subscription
    },
    onEvent: handleRuntimeClientEvent
  })

  // Seed connected-runtime discovery or existing remote projects stay hidden until Add Project.
  const initialRuntimeEnvironmentState = readSyncState()
  const runtimeClientEventEnvironmentIds = getRuntimeClientEventEnvironmentIds(
    initialRuntimeEnvironmentState
  )
  for (const environmentId of runtimeClientEventEnvironmentIds) {
    requestProjectRefresh(environmentId)
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
      requestProjectRefresh(environmentId),
    markEnvironmentSshStateStale: (environmentId) => {
      // No-op when the environment has no SSH bucket (e.g. web client).
      useAppStore.getState().markEnvironmentSshStateStale(environmentId)
    },
    sync: runtimeClientEventsSync.sync
  })
  const unsubscribeRuntimeEnvironmentStore = subscribeAppStoreWithStatuses(
    runtimeEnvironmentSyncWrites(handleRuntimeEnvironmentStoreWrite)
  )
  // Subscribe before streams start; replay invalidation can synchronously publish SSH buckets needing exactly one replacement subscription.
  runtimeClientEventsSync.sync()
  unsubs.push(runtimeClientEventsSync.stop)
  unsubs.push(runtimeProjectRefreshScheduler.stop)

  return unsubscribeRuntimeEnvironmentStore
}
