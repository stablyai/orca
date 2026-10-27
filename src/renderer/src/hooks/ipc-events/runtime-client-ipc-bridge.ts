import { applyHostWorktreeTerminalSleepState } from '@/components/terminal-pane/pty-shutdown-exit-deferral'
import { dispatchTerminalSideEffectBatch } from '@/components/terminal-pane/terminal-side-effect-facts-handler'
import { emitAutomationsChangedWindowEvent } from '@/lib/automations-changed-window-event'
import { applyNativeChatLaunchDraftResolved } from '@/runtime/native-chat-launch-draft-runtime-resolution'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import {
  refreshRuntimeEnvironmentCatalog,
  setRuntimeEnvironmentCatalogRefresher
} from '@/runtime/runtime-environment-pairing-refresh'
import {
  applyRuntimeEnvironmentSshStateChanged,
  hydrateRuntimeEnvironmentSshState,
  refreshRuntimeEnvironmentSshTargetMetadata
} from '@/runtime/runtime-environment-ssh-state'
import { subscribeRuntimeClientEvents } from '@/runtime/runtime-client-events'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { getEnvironmentSshStateGeneration } from '@/store/slices/runtime-environment-ssh'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import { getRepoExecutionHostId, toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import { navigationTargetsClients } from '../../../../shared/runtime-navigation'
import { useAppStore } from '../../store'
import { invalidateRemoteWorktreeLineage } from '../../store/slices/worktrees/metadata/worktree-lineage-readiness'
import { adoptFromEndpoint, type OwnedWorktreeEvent } from '../../store/adopt-from-endpoint'
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
import { readPublishedSortOrders } from '../../store/slices/worktrees/listing/worktree-sort-order-patch'

export function registerRuntimeClientIpcBridge(
  unsubs: (() => void)[],
  worktreeRuntime: WorktreeEventRuntime
): () => void {
  const { worktreeChangeRefreshQueue, activateNotifiedWorktree } = worktreeRuntime
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

  const runtimeProjectRefreshScheduler = createRuntimeProjectRefreshScheduler({
    refresh: async (environmentId) => {
      // Why: project events can reveal target CRUD, but known target states already arrive by push.
      void refreshRuntimeEnvironmentSshTargetMetadata(environmentId).catch(() => {})
      const repos = await useAppStore.getState().fetchRuntimeEnvironmentRepos(environmentId)
      // Group/folder edits share reposChanged; refresh groups before folders to resolve their owners.
      const runtimeOwner = { runtimeEnvironmentId: environmentId }
      // Refresh catalogs/worktrees independently so two catalog RPC timeouts cannot delay lineage convergence.
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
  const requestProjectRefresh = (environmentId: string): void => {
    invalidateRemoteWorktreeLineage(useAppStore.getState, environmentId)
    runtimeProjectRefreshScheduler.request(environmentId)
  }

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
    // A paired desktop keeps its own Workspace options; only the host's phone mirrors them.
    if (event.type === 'workspaceViewChanged') {
      return
    }
    if (event.type === 'reposChanged') {
      requestProjectRefresh(environmentId)
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
      void useAppStore
        .getState()
        .refreshLinearIssue(event.identifier, event.workspaceId)
        .catch((error) => {
          console.error('Failed to refresh updated Linear issue:', error)
        })
      return
    }
    // This window builds its sidebar from its own store, never from a host's phone feed.
    if (event.type === 'sidebarInputsChanged') {
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
    useAppStore.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
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
    getDesiredEnvironmentIds: () => getRuntimeClientEventEnvironmentIds(useAppStore.getState()),
    getSubscriptionKey: (environmentId) => buildRuntimeClientEventEnvironmentKey([environmentId]),
    subscribe: (environmentId, onEvent, onError, isCurrent) => {
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
          if (!isCurrent()) {
            return
          }
          invalidateRuntimeClientEventReplay({
            getSshStateReference: () => useAppStore.getState().sshStateByEnvironment,
            refreshRuntimeStatus: () => {
              const state = useAppStore.getState()
              const snapshot = state.runtimeStatusByEnvironmentId.get(environmentId)?.snapshot
              if (!snapshot || snapshot.transport === 'unknown') {
                void state.refreshRuntimeEnvironmentStatus(environmentId)
              }
            },
            requestProjectRefresh: () => requestProjectRefresh(environmentId),
            markEnvironmentSshStateStale: () =>
              useAppStore.getState().markEnvironmentSshStateStale(environmentId),
            hydrateEnvironmentSshState: () =>
              hydrateRuntimeEnvironmentSshState(environmentId, { force: true }),
            sync: runtimeClientEventsSync.sync
          })
        }
      )
      return subscription
    },
    onEvent: handleRuntimeClientEvent
  })

  // Seed connected-runtime discovery or existing remote projects stay hidden until Add Project.
  const initialRuntimeEnvironmentState = useAppStore.getState()
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
  const unsubscribeRuntimeEnvironmentStore = useAppStore.subscribe(
    handleRuntimeEnvironmentStoreWrite
  )
  // Subscribe before streams start; replay invalidation can synchronously publish SSH buckets needing exactly one replacement subscription.
  runtimeClientEventsSync.sync()
  unsubs.push(runtimeClientEventsSync.stop)
  unsubs.push(runtimeProjectRefreshScheduler.stop)

  return unsubscribeRuntimeEnvironmentStore
}
