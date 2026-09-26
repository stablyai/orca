import type { PersistedUIState } from '../../../../../shared/persisted-ui-state-types'
import type { StatusBarItem } from '../../../../../shared/ui-chrome-types'
import { migrateStatusBarItems } from './ui-slice-hydration-sanitizers'

const DEFAULT_ON_PORTS_STATUS_BAR_ITEM: StatusBarItem = 'ports'
const DEFAULT_ON_KIMI_STATUS_BAR_ITEM: StatusBarItem = 'kimi'
const DEFAULT_ON_MINIMAX_STATUS_BAR_ITEM: StatusBarItem = 'minimax'
const DEFAULT_ON_ANTIGRAVITY_STATUS_BAR_ITEM: StatusBarItem = 'antigravity'
const DEFAULT_ON_GROK_STATUS_BAR_ITEM: StatusBarItem = 'grok'
const DEFAULT_ON_CURSOR_STATUS_BAR_ITEM: StatusBarItem = 'cursor'

export function hydrateStatusBarItems(ui: PersistedUIState): StatusBarItem[] {
  let items = migrateStatusBarItems(ui.statusBarItems)
  const defaults = [
    ['_portsStatusBarDefaultAdded', DEFAULT_ON_PORTS_STATUS_BAR_ITEM],
    ['_kimiStatusBarDefaultAdded', DEFAULT_ON_KIMI_STATUS_BAR_ITEM],
    ['_minimaxStatusBarDefaultAdded', DEFAULT_ON_MINIMAX_STATUS_BAR_ITEM],
    ['_antigravityStatusBarDefaultAdded', DEFAULT_ON_ANTIGRAVITY_STATUS_BAR_ITEM],
    ['_grokStatusBarDefaultAdded', DEFAULT_ON_GROK_STATUS_BAR_ITEM],
    ['_cursorStatusBarDefaultAdded', DEFAULT_ON_CURSOR_STATUS_BAR_ITEM]
  ] as const
  for (const [flag, item] of defaults) {
    if (!ui[flag] && !items.includes(item)) {
      items = [...items, item]
    }
  }
  if (typeof window !== 'undefined' && defaults.some(([flag]) => !ui[flag])) {
    window.api.ui
      .set({ statusBarItems: items, ...Object.fromEntries(defaults.map(([flag]) => [flag, true])) })
      .catch(console.error)
  }
  return items
}
