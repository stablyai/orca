import type { AppState } from '../../types'
import type { UsageData } from './usage-provider-slice-contract'
import type { UsageSnapshot, UsageProviderTypes, UsageFailure } from './usage-provider-types'
import { mergeUsageFailure, readUsageData, createUsagePatch } from './usage-provider-slice-state'

/** Every write names the Stats host view it came from, so one host's answer never lands in another's. */
export function createUsageProviderHostWrites<
  T extends UsageProviderTypes<string, string, UsageSnapshot>
>(prefix: string, set: (patch: Partial<AppState>) => void, get: () => AppState) {
  const shownView = (): number => get().statsHostEpoch
  const read = (): UsageData<T> => readUsageData<T>(get(), prefix)
  const update = (view: number, patch: Partial<UsageData<T>>): void => {
    if (view === shownView()) {
      set(createUsagePatch(prefix, patch))
    }
  }
  const updateFailure = (view: number, patch: Partial<UsageFailure>): void => {
    const previous = read().failure
    const failure = mergeUsageFailure(previous, patch)
    if (failure !== previous) {
      update(view, { failure })
    }
  }
  const setScanning = (view: number, isScanning: boolean): void => {
    const state = read().scanState
    // Starting needs tracking on; stopping needs a running scan.
    if (state && (isScanning ? state.enabled : state.isScanning)) {
      update(view, { scanState: { ...state, isScanning } })
    }
  }
  return {
    shownView,
    read,
    update,
    updateFailure,
    stopLoading: (view: number) => setScanning(view, false),
    markLoading: (view: number) => setScanning(view, true)
  }
}
