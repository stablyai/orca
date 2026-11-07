import { createContext, useContext, useMemo, useSyncExternalStore } from 'react'
import type { StoreApi, UseBoundStore } from 'zustand'
import { useAppStore } from './index'
import type { AppState } from './types'

export type AppStateView = UseBoundStore<
  Pick<StoreApi<AppState>, 'getState' | 'getInitialState' | 'subscribe'>
>
// Null defers the default store read until render, including shared hooks imported by the store.
export const AppStateViewContext = createContext<AppStateView | null>(null)

/** A retained surface can supply an immutable view without changing command ownership. */
export function useAppStateView(): AppStateView {
  return useContext(AppStateViewContext) ?? useAppStore
}

export function useAppStateValue<T>(selector: (state: AppState) => T): T {
  const useViewStore = useAppStateView()
  return useViewStore(selector)
}

export function useAppStateViewActive(): boolean {
  return useAppStateView() === useAppStore
}

const subscribeNothing = (): (() => void) => () => {}

/** View leases stop with the retained app snapshot; operation-owned observers stay live. */
export function useAppViewExternalStore<T>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => T,
  getServerSnapshot: () => T = getSnapshot
): T {
  const store = useAppStateView()
  const active = store === useAppStore
  const frozen = useMemo(() => {
    if (active) {
      return null
    }
    const snapshot = getSnapshot()
    return () => snapshot
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- The retained store identity owns the frozen snapshot.
  }, [store])
  return useSyncExternalStore(
    active ? subscribe : subscribeNothing,
    frozen ?? getSnapshot,
    frozen ?? getServerSnapshot
  )
}
