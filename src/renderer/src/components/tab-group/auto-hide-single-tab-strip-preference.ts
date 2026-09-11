import type { GlobalSettings } from '../../../../shared/global-settings-types'

// Why: cached once per session — the blocking read should only ever run on the pre-hydration
// startup path, never per render.
let persistedAutoHideFlagCache: boolean | undefined

function readPersistedAutoHideFlagSync(): boolean {
  if (persistedAutoHideFlagCache === undefined) {
    try {
      const getSync = (globalThis as { window?: Window }).window?.api?.settings?.getSync
      persistedAutoHideFlagCache =
        typeof getSync === 'function' ? getSync()?.autoHideSingleTabStrip === true : false
    } catch {
      persistedAutoHideFlagCache = false
    }
  }
  return persistedAutoHideFlagCache
}

export function isAutoHideSingleTabStripEnabled(
  settings: Pick<GlobalSettings, 'autoHideSingleTabStrip'> | null | undefined
): boolean {
  if (settings) {
    return settings.autoHideSingleTabStrip === true
  }
  // Why: settings hydrate asynchronously, and a group rendered before that would show the strip and
  // then collapse it — a 32px jump plus a pane refit on every launch.
  return readPersistedAutoHideFlagSync()
}
