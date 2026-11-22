import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import {
  runtimeStatusSubscriptionsFor,
  type RuntimeStatuses
} from '@/store/slices/runtime-status/views/runtime-status-subscriptions'
import { runtimeEnvironmentContinuityStamp } from '../../rpc/environment-revisions/runtime-environment-revision'

type ContactWatch = {
  environmentId: string
  listener: () => void
  lastMarks: string
  lastWslReady: boolean
  active: boolean
}

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

const watchesByEnvironment = new Map<string, Set<ContactWatch>>()
let stopSources: (() => void) | null = null

function regained(watch: ContactWatch, state: AppState, statuses: RuntimeStatuses): boolean {
  const wslReady = wslHostReady(state, watch.environmentId)
  const becameReady = wslReady && !watch.lastWslReady
  watch.lastWslReady = wslReady
  const marks = contactMarks(statuses, watch.environmentId)
  if (marks === watch.lastMarks && !becameReady) {
    return false
  }
  watch.lastMarks = marks
  return true
}

function evaluate(environmentIds: Iterable<string>): void {
  const state = useAppStore.getState()
  const statuses = runtimeStatusSubscriptionsFor(useAppStore).readStatuses()
  const due: ContactWatch[] = []
  for (const environmentId of environmentIds) {
    for (const watch of watchesByEnvironment.get(environmentId) ?? []) {
      if (regained(watch, state, statuses)) {
        due.push(watch)
      }
    }
  }
  // Every baseline is set before a listener can commit a nested write.
  for (const watch of due) {
    if (!watch.active) {
      continue
    }
    // Baselines already moved, so one failing watcher must not swallow another's wake.
    try {
      watch.listener()
    } catch (error) {
      console.error('Runtime host contact watcher failed', error)
    }
  }
}

function ensureSources(): void {
  if (stopSources) {
    return
  }
  // A status write re-checks only the hosts it touched; catalog and WSL changes re-check every host.
  const stopStatuses = runtimeStatusSubscriptionsFor(useAppStore).subscribeStatusChanges((change) =>
    evaluate([...change.ids])
  )
  const stopStore = useAppStore.subscribe((state, previous) => {
    if (
      state.wslHostStatuses !== previous.wslHostStatuses ||
      state.runtimeEnvironments !== previous.runtimeEnvironments
    ) {
      evaluate([...watchesByEnvironment.keys()])
    }
  })
  stopSources = () => {
    stopStatuses()
    stopStore()
  }
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
  const state = useAppStore.getState()
  const watch: ContactWatch = {
    environmentId,
    listener,
    lastMarks: contactMarks(
      runtimeStatusSubscriptionsFor(useAppStore).readStatuses(),
      environmentId
    ),
    lastWslReady: wslHostReady(state, environmentId),
    active: true
  }
  ensureSources()
  let watches = watchesByEnvironment.get(environmentId)
  if (!watches) {
    watches = new Set()
    watchesByEnvironment.set(environmentId, watches)
  }
  watches.add(watch)
  const owned = watches
  return () => {
    if (!watch.active) {
      return
    }
    watch.active = false
    owned.delete(watch)
    if (owned.size === 0 && watchesByEnvironment.get(environmentId) === owned) {
      watchesByEnvironment.delete(environmentId)
    }
    if (watchesByEnvironment.size === 0) {
      stopSources?.()
      stopSources = null
    }
  }
}
