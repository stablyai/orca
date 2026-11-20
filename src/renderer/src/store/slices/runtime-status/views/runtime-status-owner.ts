import { useAppStore } from '../../../index'
import type { AppState } from '../../../types'
import type { AppStateView } from '../../../retained-views/app-state-view'
import {
  runtimeStatusSubscriptionsFor,
  subscribeStoreWithStatuses,
  type RuntimeStatuses,
  type RuntimeStatusSubscriptions
} from './runtime-status-subscriptions'

export type { RuntimeStatuses } from './runtime-status-subscriptions'

// Resolved on first use so modules that load before the store (or test doubles of it) never touch it.
export function appRuntimeStatusSubscriptions(): RuntimeStatusSubscriptions {
  return runtimeStatusSubscriptionsFor(useAppStore)
}

/** Every host's current status, read through the host status owner. */
export function readRuntimeStatuses(): RuntimeStatuses {
  return appRuntimeStatusSubscriptions().readStatuses()
}

/** Wakes when any host's status changes, and on nothing else. */
export function subscribeRuntimeStatuses(listener: () => void): () => void {
  return appRuntimeStatusSubscriptions().subscribeStatuses(listener)
}

/** Hands each host status change with the map it replaced. */
export function subscribeRuntimeStatusChanges(
  listener: (statuses: RuntimeStatuses, previous: RuntimeStatuses) => void
): () => void {
  const owner = appRuntimeStatusSubscriptions()
  let previous = owner.readStatuses()
  return owner.subscribeStatuses(() => {
    const statuses = owner.readStatuses()
    if (statuses === previous) {
      return
    }
    const replaced = previous
    previous = statuses
    listener(statuses, replaced)
  })
}

/** One callback per app store publication with the host statuses on each side of it. */
export function subscribeAppStoreWithStatuses(
  listener: (
    state: AppState,
    previous: AppState,
    statuses: RuntimeStatuses,
    previousStatuses: RuntimeStatuses
  ) => void
): () => void {
  return subscribeStoreWithStatuses(useAppStore, listener)
}

const retainedStatusesByView = new WeakMap<AppStateView, RuntimeStatuses>()

/** Freezes the host statuses a retained view shows, captured with its app state snapshot. */
export function retainRuntimeStatusesForView(view: AppStateView, statuses: RuntimeStatuses): void {
  retainedStatusesByView.set(view, statuses)
}

/** Host statuses as a view sees them: frozen for a retained view, live for the app store. */
export function readRuntimeStatusesForView(view: AppStateView): RuntimeStatuses {
  return retainedStatusesByView.get(view) ?? runtimeStatusSubscriptionsFor(view).readStatuses()
}
