import { installWindowVisibilityInterval, isWindowVisible } from '@/lib/window-visibility-interval'
import { relayingRuntimeOwners } from '@/runtime/relayed-runtime-hosts'
import { useAppStore } from '../../store'
import { relayedRuntimeOwnerKey } from '../../store/slices/relayed-runtime-hosts'
import type { AppState } from '../../store/types'

// Same cadence as main's paired-server fallback refresh; managed servers announce no events to this client.
const RELAYED_HOSTS_REFRESH_MS = 30_000

type PollingStore = Pick<typeof useAppStore, 'getState' | 'subscribe'>

function inContactOwnersKey(state: AppState): string {
  return relayingRuntimeOwners(state)
    .filter((owner) => owner.inContact)
    .map(relayedRuntimeOwnerKey)
    .join('\n')
}

/** Poll relaying servers in contact while the window is visible; re-read at once when that set changes. */
export function installRelayedRuntimeHostsPolling(
  store: PollingStore = useAppStore,
  installInterval: typeof installWindowVisibilityInterval = installWindowVisibilityInterval
): () => void {
  let ownersKey = ''
  let stopInterval: (() => void) | null = null
  const refresh = (): void => {
    void store.getState().refreshRelayedRuntimeHosts()
  }
  // Catalog and status events both land in the store; pairings, contact and downgrades show up here.
  const sync = (): void => {
    const key = inContactOwnersKey(store.getState())
    if (key === ownersKey) {
      return
    }
    ownersKey = key
    if (key === '') {
      stopInterval?.()
      stopInterval = null
      return
    }
    if (!stopInterval) {
      // Runs at once when visible, then on the interval; a hidden window waits for visibility.
      stopInterval = installInterval({ run: refresh, intervalMs: RELAYED_HOSTS_REFRESH_MS })
    } else if (isWindowVisible()) {
      refresh()
    }
  }
  const unsubscribe = store.subscribe((state, previous) => {
    if (
      state.runtimeEnvironments !== previous.runtimeEnvironments ||
      state.runtimeStatusByEnvironmentId !== previous.runtimeStatusByEnvironmentId
    ) {
      sync()
    }
  })
  sync()
  return () => {
    unsubscribe()
    stopInterval?.()
    stopInterval = null
  }
}
