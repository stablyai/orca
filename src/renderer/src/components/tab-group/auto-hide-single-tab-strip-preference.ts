import type { GlobalSettings } from '../../../../shared/global-settings-types'

// Why: cached once per session — the blocking read should only ever run on the pre-hydration
// startup path, never per render.
let persistedAutoHideFlagCache: boolean | undefined

function readPersistedAutoHideFlagSync(): boolean {
  if (persistedAutoHideFlagCache === undefined) {
    try {
      // Why: `typeof` guard — unit tests run without a window, where a bare reference throws.
      const getSync = typeof window === 'undefined' ? undefined : window.api?.settings?.getSync
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
    // Why: a later null window (a runtime switch re-hydrating) must not revive the session-start read.
    persistedAutoHideFlagCache = settings.autoHideSingleTabStrip === true
    return persistedAutoHideFlagCache
  }
  // Why: settings hydrate asynchronously, and a group rendered before that would show the strip and
  // then collapse it — a 32px jump plus a pane refit on every launch.
  return readPersistedAutoHideFlagSync()
}
