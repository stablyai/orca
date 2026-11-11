import type { AppState } from './types'
import { installTerminalParkingInputs } from './terminals/terminal-parking-input-transitions'
import { installPRAutoRefreshCadenceObserver } from './github/refresh/pr-auto-refresh-cadence-observer'

export type StoreObserverHost = {
  getState: () => AppState
  subscribe: (listener: (state: AppState, previous: AppState) => void) => () => void
}

/** Observers installed once at store creation, before app consumers subscribe; none may wrap `set`. */
export type StoreObserverInstaller = (store: StoreObserverHost) => void

export const STORE_OBSERVER_INSTALLERS: readonly StoreObserverInstaller[] = [
  installTerminalParkingInputs,
  installPRAutoRefreshCadenceObserver
]
