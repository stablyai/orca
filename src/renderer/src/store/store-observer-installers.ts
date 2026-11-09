import type { AppState } from './types'

export type StoreObserverHost = {
  getState: () => AppState
  subscribe: (listener: (state: AppState, previous: AppState) => void) => () => void
}

/** Observers installed once at store creation, before app consumers subscribe; none may wrap `set`. */
export type StoreObserverInstaller = (store: StoreObserverHost) => void

export const STORE_OBSERVER_INSTALLERS: readonly StoreObserverInstaller[] = []
