import {
  getSettingsFocusedExecutionHostId,
  parseExecutionHostId
} from '../../../shared/execution-host'
import { useAppStore } from '../store'
import { getExecutionHostDisplayLabel } from './runtime-environment-display-name'
import { watchOwnedRateLimits, type OwnedRateLimitsWatcher } from './runtime-usage-owner-client'

/**
 * Keeps displayed usage pointed at the selected execution owner, and streams a
 * paired runtime's usage from the accounts snapshot it already publishes.
 * Local usage arrives on the desktop IPC push instead.
 */
export function subscribeRateLimitUsageOwner(): () => void {
  // `undefined` means "not followed yet"; a real selection is `string | null`.
  let followedEnvironmentId: string | null | undefined
  let watcher: OwnedRateLimitsWatcher | null = null

  const follow = (): void => {
    const environmentId =
      useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() || null
    if (environmentId === followedEnvironmentId) {
      return
    }
    followedEnvironmentId = environmentId
    const hostId = getSettingsFocusedExecutionHostId({
      activeRuntimeEnvironmentId: environmentId
    })
    // Closing first stops the previous owner's stream at the source, so its
    // in-flight snapshots never reach the store at all.
    watcher?.close()
    watcher = null
    useAppStore.getState().setRateLimitUsageOwner(hostId)
    if (parseExecutionHostId(hostId)?.kind !== 'runtime') {
      return
    }
    const store = useAppStore.getState()
    const generation = store.rateLimitUsageByHost[hostId]?.generation ?? 0
    const label = getExecutionHostDisplayLabel(store.runtimeEnvironments, hostId)
    watcher = watchOwnedRateLimits(hostId, label, (reading) => {
      useAppStore.getState().applyOwnedRateLimits({ hostId, generation, reading })
    })
  }

  follow()
  // Why: the listener runs on every store update, and terminal output alone
  // drives many per frame. Compare the raw selection before any derivation.
  const unsubscribe = useAppStore.subscribe((state, previousState) => {
    if (
      state.settings?.activeRuntimeEnvironmentId ===
      previousState.settings?.activeRuntimeEnvironmentId
    ) {
      return
    }
    follow()
  })
  return () => {
    unsubscribe()
    watcher?.close()
    watcher = null
  }
}
