import { applyHostWorktreeTerminalSleepState } from '@/components/terminal-pane/pty-shutdown-exit-deferral'
import { dispatchTerminalSideEffectBatch } from '@/components/terminal-pane/terminal-side-effect-facts-handler'
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

  const runtimeClientEventsSync = createRuntimeClientEventsSync({
    getDesiredEnvironmentIds: () => getRuntimeClientEventEnvironmentIds(useAppStore.getState()),
    getSubscriptionKey: (environmentId) => buildRuntimeClientEventEnvironmentKey([environmentId]),
    subscribe: (environmentId, onEvent, onError) => {
      const sshGeneration = getEnvironmentSshStateGeneration(environmentId)
      const runtimeGeneration = getRuntimeEnvironmentConnectionGeneration(environmentId)
      const runtimeRevision = getRuntimeEnvironmentRevision(environmentId)
      return subscribeRuntimeClientEvents(
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
            requestProjectRefresh: () => runtimeProjectRefreshScheduler.request(environmentId),
            markEnvironmentSshStateStale: () =>
              useAppStore.getState().markEnvironmentSshStateStale(environmentId),
            hydrateEnvironmentSshState: () =>
              hydrateRuntimeEnvironmentSshState(environmentId, { force: true }),
            sync: runtimeClientEventsSync.sync
          })
        }
      )
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
