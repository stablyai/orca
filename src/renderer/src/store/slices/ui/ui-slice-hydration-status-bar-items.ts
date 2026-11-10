import type { PersistedUIState } from '../../../../../shared/persisted-ui-state-types'
import {
  applyDefaultOnStatusBarItems,
  defaultOnStatusBarFlagPatch
} from '../../../../../shared/status-bar-defaults'
import type { StatusBarItem } from '../../../../../shared/ui-chrome-types'

export function hydrateStatusBarItems(ui: PersistedUIState): StatusBarItem[] {
  const applied = applyDefaultOnStatusBarItems(ui)
  // Headless serve never constructs this window, so profile load persists the same step.
  if (typeof window !== 'undefined' && applied.needsSave) {
    window.api.ui
      .set({ statusBarItems: applied.items, ...defaultOnStatusBarFlagPatch() })
      .catch(console.error)
  }
  return applied.items
}
