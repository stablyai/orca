import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'

function contactMarks(state: AppState, environmentId: string): string | null {
  const entry = state.runtimeStatusByEnvironmentId.get(environmentId)
  return entry ? `${entry.hostContactEpoch ?? 0}:${entry.connectionGeneration ?? 0}` : null
}

/**
 * Calls `listener` each time this client regains contact with an environment's runtime: the
 * same-runtime return (`hostContactEpoch`) or a new runtime session (`connectionGeneration`),
 * both published by runtime-status.ts.
 */
export function subscribeRuntimeHostContactRegained(
  environmentId: string,
  listener: () => void
): () => void {
  let lastMarks = contactMarks(useAppStore.getState(), environmentId)
  return useAppStore.subscribe((state, previousState) => {
    if (state.runtimeStatusByEnvironmentId === previousState.runtimeStatusByEnvironmentId) {
      return
    }
    const marks = contactMarks(state, environmentId)
    // Why keep the last marks across a missing entry: a cleared status that returns is a reconnect.
    if (marks === null || marks === lastMarks) {
      return
    }
    lastMarks = marks
    listener()
  })
}
