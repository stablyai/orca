import type { StatusBarItem } from '../../../../../shared/ui-chrome-types'
import type { PersistedUIState } from '../../../../../shared/persisted-ui-state-types'
import { migrateStatusBarItems } from './ui-slice-hydration-sanitizers'

const DEFAULT_ON_PORTS_STATUS_BAR_ITEM: StatusBarItem = 'ports'
const DEFAULT_ON_KIMI_STATUS_BAR_ITEM: StatusBarItem = 'kimi'
const DEFAULT_ON_MINIMAX_STATUS_BAR_ITEM: StatusBarItem = 'minimax'
const DEFAULT_ON_ANTIGRAVITY_STATUS_BAR_ITEM: StatusBarItem = 'antigravity'
const DEFAULT_ON_GROK_STATUS_BAR_ITEM: StatusBarItem = 'grok'
const DEFAULT_ON_NOUS_STATUS_BAR_ITEM: StatusBarItem = 'nous'

// Why: each default-on status item gets a one-shot migration flag so an older
// persisted profile gains the new bar exactly once; the flags are written back
// together with the final item list so a relaunch never re-adds them.
export type StatusBarDefaultMigration = {
  items: StatusBarItem[]
  needsPersist: boolean
}

export function resolveStatusBarDefaultMigration(ui: PersistedUIState): StatusBarDefaultMigration {
  const migratedStatusBarItems = migrateStatusBarItems(ui.statusBarItems)
  const statusBarItemsWithPorts: StatusBarItem[] =
    ui._portsStatusBarDefaultAdded || migratedStatusBarItems.includes('ports')
      ? migratedStatusBarItems
      : [...migratedStatusBarItems, DEFAULT_ON_PORTS_STATUS_BAR_ITEM]
  const statusBarItems: StatusBarItem[] =
    ui._kimiStatusBarDefaultAdded || statusBarItemsWithPorts.includes('kimi')
      ? statusBarItemsWithPorts
      : [...statusBarItemsWithPorts, DEFAULT_ON_KIMI_STATUS_BAR_ITEM]
  const statusBarItemsWithMiniMax: StatusBarItem[] =
    ui._minimaxStatusBarDefaultAdded || statusBarItems.includes('minimax')
      ? statusBarItems
      : [...statusBarItems, DEFAULT_ON_MINIMAX_STATUS_BAR_ITEM]
  const statusBarItemsWithAntigravity: StatusBarItem[] =
    ui._antigravityStatusBarDefaultAdded || statusBarItemsWithMiniMax.includes('antigravity')
      ? statusBarItemsWithMiniMax
      : [...statusBarItemsWithMiniMax, DEFAULT_ON_ANTIGRAVITY_STATUS_BAR_ITEM]
  const statusBarItemsWithGrok: StatusBarItem[] =
    ui._grokStatusBarDefaultAdded || statusBarItemsWithAntigravity.includes('grok')
      ? statusBarItemsWithAntigravity
      : [...statusBarItemsWithAntigravity, DEFAULT_ON_GROK_STATUS_BAR_ITEM]
  const statusBarItemsWithNous: StatusBarItem[] =
    ui._nousStatusBarDefaultAdded || statusBarItemsWithGrok.includes('nous')
      ? statusBarItemsWithGrok
      : [...statusBarItemsWithGrok, DEFAULT_ON_NOUS_STATUS_BAR_ITEM]
  return {
    items: statusBarItemsWithNous,
    needsPersist: !(
      ui._portsStatusBarDefaultAdded &&
      ui._kimiStatusBarDefaultAdded &&
      ui._minimaxStatusBarDefaultAdded &&
      ui._antigravityStatusBarDefaultAdded &&
      ui._grokStatusBarDefaultAdded &&
      ui._nousStatusBarDefaultAdded
    )
  }
}
