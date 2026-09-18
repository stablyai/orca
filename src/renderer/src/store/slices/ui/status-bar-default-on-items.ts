import type { PersistedUIState } from '../../../../../shared/persisted-ui-state-types'
import type { StatusBarItem } from '../../../../../shared/ui-chrome-types'
import { migrateStatusBarItems } from './ui-slice-hydration-sanitizers'

// Why: providers added to the default-on set after users first ran Orca need a
// one-shot migration flag each; once written, a user-hidden item stays hidden.
const DEFAULT_ON_ITEMS = [
  ['_portsStatusBarDefaultAdded', 'ports'],
  ['_kimiStatusBarDefaultAdded', 'kimi'],
  ['_minimaxStatusBarDefaultAdded', 'minimax'],
  ['_antigravityStatusBarDefaultAdded', 'antigravity'],
  ['_grokStatusBarDefaultAdded', 'grok'],
  ['_devinStatusBarDefaultAdded', 'devin']
] as const

export function hydrateStatusBarItems(ui: PersistedUIState): StatusBarItem[] {
  let items = migrateStatusBarItems(ui.statusBarItems)
  for (const [flag, item] of DEFAULT_ON_ITEMS) {
    if (!ui[flag] && !items.includes(item)) {
      items = [...items, item]
    }
  }
  if (typeof window !== 'undefined' && DEFAULT_ON_ITEMS.some(([flag]) => !ui[flag])) {
    window.api.ui
      .set({
        statusBarItems: items,
        ...Object.fromEntries(DEFAULT_ON_ITEMS.map(([flag]) => [flag, true]))
      })
      .catch(console.error)
  }
  return items
}
