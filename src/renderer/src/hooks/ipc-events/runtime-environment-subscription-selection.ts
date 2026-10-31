import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import {
  isConnectedRuntimeHostState,
  runtimeHostConnectionStateForEntry
} from '@/runtime/runtime-host-connection-state'
import { getEnvironmentSshStateGeneration } from '@/store/slices/runtime-environment-ssh'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import type { AppState } from '../../store/types'

export type RuntimeEnvironmentStoreSyncState = Pick<
  AppState,
  'runtimeEnvironments' | 'runtimeStatusByEnvironmentId' | 'settings' | 'sshStateByEnvironment'
>

function getActiveRuntimeEnvironmentId(state: RuntimeEnvironmentStoreSyncState): string | null {
  return state.settings?.activeRuntimeEnvironmentId?.trim() || null
}

export function getRuntimeClientEventEnvironmentIds(
  state: RuntimeEnvironmentStoreSyncState
): string[] {
  const ids = new Set<string>()
  const activeEnvironmentId = getActiveRuntimeEnvironmentId(state)
  if (activeEnvironmentId) {
    ids.add(activeEnvironmentId)
  }
  for (const environment of state.runtimeEnvironments ?? []) {
    if (isRuntimeHostStillInContact(state, environment.id)) {
      ids.add(environment.id)
    }
  }
  return [...ids]
}

/** Use transport evidence, not nullable probe status: unverifiable probes can coexist with live events and must not drop subscriptions (ssh-execution-boundary.md). */
function isRuntimeHostStillInContact(
  state: RuntimeEnvironmentStoreSyncState,
  environmentId: string
): boolean {
  return isConnectedRuntimeHostState(
    runtimeHostConnectionStateForEntry(state.runtimeStatusByEnvironmentId?.get(environmentId))
  )
}

export function getReachableRuntimeEnvironmentIds(
  state: RuntimeEnvironmentStoreSyncState
): string[] {
  const ids: string[] = []
  for (const environmentId of state.runtimeStatusByEnvironmentId?.keys() ?? []) {
    if (isRuntimeHostStillInContact(state, environmentId)) {
      ids.push(environmentId)
    }
  }
  return ids
}

export function canSkipRuntimeEnvironmentStoreSync(
  state: RuntimeEnvironmentStoreSyncState,
  previousState: RuntimeEnvironmentStoreSyncState
): boolean {
  return (
    state.runtimeEnvironments === previousState.runtimeEnvironments &&
    state.runtimeStatusByEnvironmentId === previousState.runtimeStatusByEnvironmentId &&
    state.sshStateByEnvironment === previousState.sshStateByEnvironment &&
    getActiveRuntimeEnvironmentId(state) === getActiveRuntimeEnvironmentId(previousState)
  )
}

export function buildRuntimeClientEventEnvironmentKey(environmentIds: string[]): string {
  return [...new Set(environmentIds)]
    .sort()
    .map(
      (environmentId) =>
        `${environmentId}:${getRuntimeEnvironmentConnectionGeneration(environmentId)}:${getEnvironmentSshStateGeneration(environmentId)}:${getRuntimeEnvironmentRevision(environmentId) ?? 'unknown'}`
    )
    .join('\u0000')
}

function getNewlyConnectedRuntimeEnvironmentIds(
  previous: readonly string[],
  next: readonly string[]
): string[] {
  const known = new Set(previous)
  return [...new Set(next)].filter((environmentId) => !known.has(environmentId))
}

function getNewlyDisconnectedRuntimeEnvironmentIds(
  previous: readonly string[],
  next: readonly string[]
): string[] {
  return getNewlyConnectedRuntimeEnvironmentIds(next, previous)
}

function getRuntimeProjectRefreshEnvironmentIds(args: {
  previousDesired: readonly string[]
  nextDesired: readonly string[]
  previousReachable: readonly string[]
  nextReachable: readonly string[]
}): string[] {
  return [
    ...new Set([
      ...getNewlyConnectedRuntimeEnvironmentIds(args.previousDesired, args.nextDesired),
      ...getNewlyConnectedRuntimeEnvironmentIds(args.previousReachable, args.nextReachable)
    ])
  ]
}

type RuntimeEnvironmentStoreSyncSubscriberDeps = {
  initialDesiredEnvironmentIds: string[]
  initialReachableEnvironmentIds: string[]
  buildEnvironmentKey: (environmentIds: string[]) => string
  getDesiredEnvironmentIds: (state: RuntimeEnvironmentStoreSyncState) => string[]
  getReachableEnvironmentIds: (state: RuntimeEnvironmentStoreSyncState) => string[]
  requestProjectRefresh: (environmentId: string) => void
  markEnvironmentSshStateStale: (environmentId: string) => void
  sync: () => void
}

export type RuntimeEnvironmentStoreSyncSubscriber = (
  state: RuntimeEnvironmentStoreSyncState,
  previousState: RuntimeEnvironmentStoreSyncState
) => void

/** Gate subscription scans first by relevant slice references, then effective key, to avoid enumerating hosts on unrelated writes. */
export function createRuntimeEnvironmentStoreSyncSubscriber(
  deps: RuntimeEnvironmentStoreSyncSubscriberDeps
): RuntimeEnvironmentStoreSyncSubscriber {
  let desiredEnvironmentIds = deps.initialDesiredEnvironmentIds
  let desiredEnvironmentKey = deps.buildEnvironmentKey(desiredEnvironmentIds)
  let reachableEnvironmentIds = deps.initialReachableEnvironmentIds
  let reachableEnvironmentKey = deps.buildEnvironmentKey(reachableEnvironmentIds)
  let handlingStoreWrite = false

  return (state, previousState) => {
    // The outer pass incorporates synchronous SSH-stale publication; suppress re-entry so that transition syncs once.
    if (handlingStoreWrite || canSkipRuntimeEnvironmentStoreSync(state, previousState)) {
      return
    }

    handlingStoreWrite = true
    try {
      const nextDesiredEnvironmentIds = deps.getDesiredEnvironmentIds(state)
      const nextReachableEnvironmentIds = deps.getReachableEnvironmentIds(state)
      const refreshEnvironmentIds = getRuntimeProjectRefreshEnvironmentIds({
        previousDesired: desiredEnvironmentIds,
        nextDesired: nextDesiredEnvironmentIds,
        previousReachable: reachableEnvironmentIds,
        nextReachable: nextReachableEnvironmentIds
      })
      const disconnectedEnvironmentIds = getNewlyDisconnectedRuntimeEnvironmentIds(
        reachableEnvironmentIds,
        nextReachableEnvironmentIds
      )

      desiredEnvironmentIds = nextDesiredEnvironmentIds
      reachableEnvironmentIds = nextReachableEnvironmentIds
      for (const environmentId of refreshEnvironmentIds) {
        deps.requestProjectRefresh(environmentId)
      }
      for (const environmentId of disconnectedEnvironmentIds) {
        deps.markEnvironmentSshStateStale(environmentId)
      }

      // Capture SSH generation after disconnect invalidation advances it, in the same replacement sync.
      const nextDesiredEnvironmentKey = deps.buildEnvironmentKey(desiredEnvironmentIds)
      const nextReachableEnvironmentKey = deps.buildEnvironmentKey(reachableEnvironmentIds)
      if (
        nextDesiredEnvironmentKey === desiredEnvironmentKey &&
        nextReachableEnvironmentKey === reachableEnvironmentKey
      ) {
        return
      }
      desiredEnvironmentKey = nextDesiredEnvironmentKey
      reachableEnvironmentKey = nextReachableEnvironmentKey
      deps.sync()
    } finally {
      handlingStoreWrite = false
    }
  }
}

type RuntimeClientEventReplayInvalidationDeps = {
  getSshStateReference: () => RuntimeEnvironmentStoreSyncState['sshStateByEnvironment']
  refreshRuntimeStatus: () => void
  requestProjectRefresh: () => void
  markEnvironmentSshStateStale: () => void
  hydrateEnvironmentSshState: () => Promise<unknown>
  sync: () => void
}

/** Replay gaps advance SSH generation; tracked-bucket publication syncs via subscriber, while empty/already-stale buckets need explicit sync. */
export function invalidateRuntimeClientEventReplay(
  deps: RuntimeClientEventReplayInvalidationDeps
): void {
  // Re-probe after reconnect or the host can stay visually disconnected while RPCs/terminals work.
  deps.refreshRuntimeStatus()
  deps.requestProjectRefresh()
  const previousSshStateReference = deps.getSshStateReference()
  deps.markEnvironmentSshStateStale()
  if (deps.getSshStateReference() === previousSshStateReference) {
    deps.sync()
  }
  void deps.hydrateEnvironmentSshState().catch(() => {})
}
