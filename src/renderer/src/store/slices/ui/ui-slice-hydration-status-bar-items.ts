import type { PersistedUIState } from '../../../../../shared/orca-profiles/persisted-ui-state-types'
import { applyDefaultOnStatusBarItems } from '../../../../../shared/status-bar/status-bar-defaults'

export function hydrateStatusBarPreferences(ui: PersistedUIState) {
  const applied = applyDefaultOnStatusBarItems(ui)
  // Main applies this on profile load too, since a headless serve never runs a renderer.
  if (typeof window !== 'undefined' && applied.needsSave) {
    window.api.ui.set({ statusBarItems: applied.items, ...applied.flags }).catch(console.error)
  }
  return {
    statusBarItems: applied.items,
    hiddenPluginUsageProviders: ui.hiddenPluginUsageProviders ?? []
  }
}
