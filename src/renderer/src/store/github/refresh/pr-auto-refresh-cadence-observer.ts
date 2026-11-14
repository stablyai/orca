import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { setPRAutoRefreshCadence } from '../../../../../shared/review-refresh-policy'

type CadenceState = { settings: Pick<GlobalSettings, 'prAutoRefresh'> | null }

type CadenceStoreHost = {
  getState: () => CadenceState
  subscribe: (listener: (state: CadenceState, previous: CadenceState) => void) => () => void
}

/** Every renderer review scheduler reads the shared cadence; set it before their own subscribers
 *  recompute targets on the same settings change. */
export function installPRAutoRefreshCadenceObserver(store: CadenceStoreHost): void {
  setPRAutoRefreshCadence(store.getState().settings?.prAutoRefresh)
  store.subscribe((state, previous) => {
    if (state.settings?.prAutoRefresh !== previous.settings?.prAutoRefresh) {
      setPRAutoRefreshCadence(state.settings?.prAutoRefresh)
    }
  })
}
