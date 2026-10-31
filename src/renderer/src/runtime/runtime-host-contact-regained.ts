import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { runtimeEnvironmentContinuityStamp } from './runtime-environment-revision'

function contactMarks(state: AppState, environmentId: string): string {
  const entry = state.runtimeStatusByEnvironmentId.get(environmentId)
  return entry
    ? JSON.stringify([
        entry.hostContactEpoch ?? 0,
        entry.connectionGeneration ?? 0,
        runtimeEnvironmentContinuityStamp(environmentId)
      ])
    : runtimeEnvironmentContinuityStamp(environmentId)
}

function wslHostReady(state: AppState, environmentId: string): boolean {
  // Optional: test stores built from one slice carry no WSL host statuses.
  return state.wslHostStatuses?.[environmentId]?.state === 'ready'
}

/**
 * Calls `listener` each time this client regains contact with an environment's runtime: the
 * same-runtime return (`hostContactEpoch`) or a new runtime session (`connectionGeneration`),
 * resolved pairing continuity published by runtime-status.ts, or its WSL host's connection
 * becoming ready, which a status kept verified across a relaunch does not show.
 */
export function subscribeRuntimeHostContactRegained(
  environmentId: string,
  listener: () => void
): () => void {
  let lastMarks = contactMarks(useAppStore.getState(), environmentId)
  let lastWslReady = wslHostReady(useAppStore.getState(), environmentId)
  return useAppStore.subscribe((state, previousState) => {
    const wslChanged = state.wslHostStatuses !== previousState.wslHostStatuses
    if (
      !wslChanged &&
      state.runtimeStatusByEnvironmentId === previousState.runtimeStatusByEnvironmentId &&
      state.runtimeEnvironments === previousState.runtimeEnvironments
    ) {
      return
    }
    const wslReady = wslHostReady(state, environmentId)
    const becameReady = wslReady && !lastWslReady
    lastWslReady = wslReady
    const marks = contactMarks(state, environmentId)
    if (marks === lastMarks && !becameReady) {
      return
    }
    lastMarks = marks
    listener()
  })
}
