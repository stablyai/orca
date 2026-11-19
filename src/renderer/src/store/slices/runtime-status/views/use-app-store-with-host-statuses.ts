import { useCallback, useRef, useSyncExternalStore } from 'react'
import { useAppStore } from '../../../index'
import type { AppState } from '../../../types'
import {
  useAppStateView,
  useAppStateViewActive,
  type AppStateView
} from '../../../retained-views/app-state-view'
import {
  appRuntimeStatusSubscriptions,
  readRuntimeStatusesForView,
  type RuntimeStatuses
} from './runtime-status-owner'

type HostStatusesSelector<T> = (state: AppState, statuses: RuntimeStatuses) => T
type Selection<T> = {
  state: AppState
  statuses: RuntimeStatuses
  selector: HostStatusesSelector<T>
  value: T
}

const subscribeNothing = (): (() => void) => () => {}
const liveAppStore = (): AppStateView => useAppStore

function useViewWithHostStatuses<T>(
  view: AppStateView,
  live: boolean,
  selector: HostStatusesSelector<T>,
  equality: (a: T, b: T) => boolean
): T {
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribeState = view.subscribe(listener)
      const unsubscribeStatuses = appRuntimeStatusSubscriptions().subscribeStatuses(listener)
      return () => {
        unsubscribeState()
        unsubscribeStatuses()
      }
    },
    [view]
  )
  // Why cached: both sources wake on one host write, so the second read must not rerun the selector.
  const selection = useRef<Selection<T> | null>(null)
  const getSnapshot = (): T => {
    const state = view.getState()
    const statuses = readRuntimeStatusesForView(view)
    const previous = selection.current
    if (
      previous &&
      previous.state === state &&
      previous.statuses === statuses &&
      previous.selector === selector
    ) {
      return previous.value
    }
    const next = selector(state, statuses)
    const value = previous && equality(previous.value, next) ? previous.value : next
    selection.current = { state, statuses, selector, value }
    return value
  }
  return useSyncExternalStore(live ? subscribe : subscribeNothing, getSnapshot, getSnapshot)
}

/** useAppStore for a selector that also reads host statuses, which come from the host status owner. */
export function useAppStoreWithHostStatuses<T>(
  selector: HostStatusesSelector<T>,
  equality: (a: T, b: T) => boolean = Object.is
): T {
  return useViewWithHostStatuses(liveAppStore(), true, selector, equality)
}

/** useAppStateValue for that selector: a retained view reads the statuses frozen with it. */
export function useAppStateValueWithHostStatuses<T>(
  selector: HostStatusesSelector<T>,
  equality: (a: T, b: T) => boolean = Object.is
): T {
  const view = useAppStateView()
  const live = useAppStateViewActive()
  return useViewWithHostStatuses(view, live, selector, equality)
}
