/** Hover-mode timings from the design spec (rail-autohide mockup). */
export const APP_RAIL_REVEAL_DELAY_MS = 100
export const APP_RAIL_HIDE_DELAY_MS = 300
export const APP_RAIL_EDGE_ZONE_PX = 8
export const APP_RAIL_FIRST_RUN_DOCKED_MS = 1000
export const APP_RAIL_FIRST_RUN_LINGER_MS = 680

export type AppRailAutohideVariant = 'dock' | 'float' | 'sliver'

// Prototype-only: pick the overlay style from DevTools without a setting.
const VARIANT_STORAGE_KEY = 'orca.railAutohideVariant'
const FIRST_RUN_REPLAY_STORAGE_KEY = 'orca.railAutohideReplayFirstRun'

export function readAppRailAutohideVariant(): AppRailAutohideVariant {
  try {
    const value = window.localStorage.getItem(VARIANT_STORAGE_KEY)
    return value === 'dock' || value === 'sliver' ? value : 'float'
  } catch {
    return 'float'
  }
}

/** Prototype-only: set the key and reload to watch the first-launch intro again. */
export function consumeAppRailFirstRunReplay(): boolean {
  try {
    if (window.localStorage.getItem(FIRST_RUN_REPLAY_STORAGE_KEY) !== '1') {
      return false
    }
    window.localStorage.removeItem(FIRST_RUN_REPLAY_STORAGE_KEY)
    return true
  } catch {
    return false
  }
}
