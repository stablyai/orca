import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
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
    if (state.runtimeStatusByEnvironmentId?.get(environment.id)?.status) {
      ids.add(environment.id)
    }
  }
  return [...ids]
}

export function getReachableRuntimeEnvironmentIds(
  state: RuntimeEnvironmentStoreSyncState
): string[] {
  const ids: string[] = []
  for (const [environmentId, status] of state.runtimeStatusByEnvironmentId ?? []) {
    if (status?.status) {
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

/** Ids in `next` not in `previous` — environments that just became connected. */
export function getNewlyConnectedRuntimeEnvironmentIds(
  previous: readonly string[],
  next: readonly string[]
): string[] {
  const known = new Set(previous)
  return [...new Set(next)].filter((environmentId) => !known.has(environmentId))
}

/** Ids in `previous` not in `next` — environments whose transport was just observed down. */
export function getNewlyDisconnectedRuntimeEnvironmentIds(
  previous: readonly string[],
  next: readonly string[]
): string[] {
  return getNewlyConnectedRuntimeEnvironmentIds(next, previous)
}

export function getRuntimeProjectRefreshEnvironmentIds(args: {
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

/**
 * Builds the one renderer-wide runtime subscriber. The reference gate runs
 * before either host collection is enumerated; key generation remains the
 * second gate for relevant-reference writes whose effective subscription set
 * did not change.
 */
export function createRuntimeEnvironmentStoreSyncSubscriber(
  deps: RuntimeEnvironmentStoreSyncSubscriberDeps
): RuntimeEnvironmentStoreSyncSubscriber {
  let desiredEnvironmentIds = deps.initialDesiredEnvironmentIds
  let desiredEnvironmentKey = deps.buildEnvironmentKey(desiredEnvironmentIds)
  let reachableEnvironmentIds = deps.initialReachableEnvironmentIds
  let reachableEnvironmentKey = deps.buildEnvironmentKey(reachableEnvironmentIds)
  let handlingStoreWrite = false

  return (state, previousState) => {
    // markEnvironmentSshStateStale can synchronously publish its nested SSH
    // bucket. The outer pass incorporates that generation before syncing, so a
    // re-entrant pass would only enumerate and sync the same transition twice.
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

      // Build after disconnect invalidation: marking a mirrored SSH bucket stale
      // advances its generation, and the replacement subscription must capture
      // that final generation in this same (single) sync.
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

/**
 * Invalidates a replay after the runtime event stream reports a transport gap.
 * A tracked SSH bucket publishes synchronously and lets the store subscriber
 * sync it; an empty/already-stale bucket has no reference publication, so this
 * path must explicitly sync the advanced module-level SSH generation.
 */
export function invalidateRuntimeClientEventReplay(
  deps: RuntimeClientEventReplayInvalidationDeps
): void {
  // Why: nothing else re-probes status.get after a reconnect, so a host recorded
  // unreachable during the gap stayed 'disconnected' in the sidebar forever while
  // its terminals and RPCs worked again.
  deps.refreshRuntimeStatus()
  deps.requestProjectRefresh()
  const previousSshStateReference = deps.getSshStateReference()
  deps.markEnvironmentSshStateStale()
  if (deps.getSshStateReference() === previousSshStateReference) {
    deps.sync()
  }
  void deps.hydrateEnvironmentSshState().catch(() => {})
}
