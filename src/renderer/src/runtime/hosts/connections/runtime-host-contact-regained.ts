import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import {
  readRuntimeStatuses,
  subscribeRuntimeStatuses,
  type RuntimeStatuses
} from '@/store/slices/runtime-status/views/runtime-status-owner'
import { runtimeEnvironmentContinuityStamp } from '../../rpc/environment-revisions/runtime-environment-revision'

function contactMarks(statuses: RuntimeStatuses, environmentId: string): string {
  const entry = statuses.get(environmentId)
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
  let lastMarks = contactMarks(readRuntimeStatuses(), environmentId)
  let lastWslReady = wslHostReady(useAppStore.getState(), environmentId)
  const check = (state: AppState): void => {
    const wslReady = wslHostReady(state, environmentId)
    const becameReady = wslReady && !lastWslReady
    lastWslReady = wslReady
    const marks = contactMarks(readRuntimeStatuses(), environmentId)
    if (marks === lastMarks && !becameReady) {
      return
    }
    lastMarks = marks
    listener()
  }
  const unsubscribeState = useAppStore.subscribe((state, previousState) => {
    if (
      state.wslHostStatuses !== previousState.wslHostStatuses ||
      state.runtimeEnvironments !== previousState.runtimeEnvironments
    ) {
      check(state)
    }
  })
  const unsubscribeStatuses = subscribeRuntimeStatuses(() => check(useAppStore.getState()))
  return () => {
    unsubscribeState()
    unsubscribeStatuses()
  }
}
