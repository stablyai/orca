import {
  runtimeStatusSubscriptionsFor,
  type RuntimeStatuses,
  type RuntimeStatusStore
} from './runtime-status-subscriptions'

let appStore: RuntimeStatusStore | null = null
const NO_STATUSES: RuntimeStatuses = new Map()

/** Called once by the app store as it is created. */
export function bindAppRuntimeStatusStore(store: RuntimeStatusStore): void {
  appStore = store
}

/** Host statuses for modules the store itself loads, which must not import the store (a cycle). */
export function readAppRuntimeStatuses(): RuntimeStatuses {
  return appStore ? runtimeStatusSubscriptionsFor(appStore).readStatuses() : NO_STATUSES
}
