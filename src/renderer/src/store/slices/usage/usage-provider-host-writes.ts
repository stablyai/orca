import type { AppState } from '../../types'
import type { UsageData } from './usage-provider-slice-contract'
import type { UsageSnapshot, UsageProviderTypes, UsageFailure } from './usage-provider-types'
import { mergeUsageFailure, readUsageData, createUsagePatch } from './usage-provider-slice-state'
import { usageHostKey } from './usage-host'

/** Every write names the host it came from, so one host's answer never lands in another's view. */
export function createUsageProviderHostWrites<
  T extends UsageProviderTypes<string, string, UsageSnapshot>
>(prefix: string, set: (patch: Partial<AppState>) => void, get: () => AppState) {
  const shownHost = (): string => usageHostKey(get().statsHost)
  const read = (): UsageData<T> => readUsageData<T>(get(), prefix)
  const update = (host: string, patch: Partial<UsageData<T>>): void => {
    if (host === shownHost()) {
      set(createUsagePatch(prefix, patch))
    }
  }
  const updateFailure = (host: string, patch: Partial<UsageFailure>): void => {
    const previous = read().failure
    const failure = mergeUsageFailure(previous, patch)
    if (failure !== previous) {
      update(host, { failure })
    }
  }
  const setScanning = (host: string, isScanning: boolean): void => {
    const state = read().scanState
    // Starting needs tracking on; stopping needs a running scan.
    if (state && (isScanning ? state.enabled : state.isScanning)) {
      update(host, { scanState: { ...state, isScanning } })
    }
  }
  return {
    shownHost,
    read,
    update,
    updateFailure,
    stopLoading: (host: string) => setScanning(host, false),
    markLoading: (host: string) => setScanning(host, true)
  }
}
