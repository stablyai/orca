/** Select hidden-delivery authority once at pane/watcher creation; mode-2031 byte-scan versus fact observers cannot change per chunk. Requires main side-effect authority and the gate switch. */
import type { GlobalSettings } from '../../../../shared/global-settings-types'

// Cache the blocking read once on pre-hydration startup, never per pane bind.
let persistedGateFlagCache: boolean | null | undefined

function readPersistedHiddenDeliveryGateFlagSync(): boolean | null {
  if (persistedGateFlagCache === undefined) {
    try {
      const getSync = (globalThis as { window?: Window }).window?.api?.settings?.getSync
      persistedGateFlagCache =
        typeof getSync === 'function' ? (getSync()?.terminalHiddenDeliveryGate ?? null) : null
    } catch {
      persistedGateFlagCache = null
    }
  }
  return persistedGateFlagCache
}

export function isRendererHiddenPtyDeliveryGateEnabled(
  settings: Pick<GlobalSettings, 'terminalHiddenDeliveryGate'> | null
): boolean {
  if (settings !== null) {
    return settings.terminalHiddenDeliveryGate !== false
  }
  // Pre-hydration bindings must honor the persisted kill switch; this observer decision is never revisited.
  return readPersistedHiddenDeliveryGateFlagSync() !== false
}
