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

/**
 * Calls `listener` each time this client regains contact with an environment's runtime: the
 * same-runtime return (`hostContactEpoch`) or a new runtime session (`connectionGeneration`),
 * or resolved pairing continuity published by runtime-status.ts.
 */
export function subscribeRuntimeHostContactRegained(
  environmentId: string,
  listener: () => void
): () => void {
  let lastMarks = contactMarks(useAppStore.getState(), environmentId)
  return useAppStore.subscribe((state, previousState) => {
    if (
      state.runtimeStatusByEnvironmentId === previousState.runtimeStatusByEnvironmentId &&
      state.runtimeEnvironments === previousState.runtimeEnvironments
    ) {
      return
    }
    const marks = contactMarks(state, environmentId)
    if (marks === lastMarks) {
      return
    }
    lastMarks = marks
    listener()
  })
}
