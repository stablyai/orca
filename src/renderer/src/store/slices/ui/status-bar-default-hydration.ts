import type { PersistedUIState } from '../../../../../shared/persisted-ui-state-types'
import type { StatusBarItem } from '../../../../../shared/ui-chrome-types'
import { migrateStatusBarItems } from './ui-slice-hydration-sanitizers'

const DEFAULT_ON_STATUS_BAR_ITEMS = [
  ['_portsStatusBarDefaultAdded', 'ports'],
  ['_kimiStatusBarDefaultAdded', 'kimi'],
  ['_minimaxStatusBarDefaultAdded', 'minimax'],
  ['_antigravityStatusBarDefaultAdded', 'antigravity'],
  ['_grokStatusBarDefaultAdded', 'grok']
] as const

export function hydrateStatusBarItems(ui: PersistedUIState): StatusBarItem[] {
  let items = migrateStatusBarItems(ui.statusBarItems)
  for (const [flag, item] of DEFAULT_ON_STATUS_BAR_ITEMS) {
    if (!ui[flag] && !items.includes(item)) {
      items = [...items, item]
    }
  }
  // Why: Z.AI's roster slot sits after Codex, so its one-shot migration inserts
  // in place instead of appending like later providers.
  if (!ui._zaiStatusBarDefaultAdded && !items.includes('zai')) {
    const codexIndex = items.indexOf('codex')
    items =
      codexIndex !== -1
        ? [...items.slice(0, codexIndex + 1), 'zai', ...items.slice(codexIndex + 1)]
        : [...items, 'zai']
  }
  if (
    typeof window !== 'undefined' &&
    (DEFAULT_ON_STATUS_BAR_ITEMS.some(([flag]) => !ui[flag]) || !ui._zaiStatusBarDefaultAdded)
  ) {
    window.api.ui
      .set({
        statusBarItems: items,
        ...Object.fromEntries(DEFAULT_ON_STATUS_BAR_ITEMS.map(([flag]) => [flag, true])),
        _zaiStatusBarDefaultAdded: true
      })
      .catch(console.error)
  }
  return items
}
