import type { PersistedUIState } from '../../../../../shared/persisted-ui-state-types'
import type { StatusBarItem } from '../../../../../shared/ui-chrome-types'

const DEFAULT_ON_STATUS_BAR_ITEMS = [
  { item: 'ports', marker: '_portsStatusBarDefaultAdded' },
  { item: 'kimi', marker: '_kimiStatusBarDefaultAdded' },
  { item: 'minimax', marker: '_minimaxStatusBarDefaultAdded' },
  { item: 'antigravity', marker: '_antigravityStatusBarDefaultAdded' },
  { item: 'grok', marker: '_grokStatusBarDefaultAdded' },
  { item: 'cursor', marker: '_cursorStatusBarDefaultAdded' }
] as const satisfies readonly {
  item: StatusBarItem
  marker: keyof PersistedUIState
}[]

type StatusBarDefaultMarker = (typeof DEFAULT_ON_STATUS_BAR_ITEMS)[number]['marker']
type StatusBarDefaultMigrationState = Pick<PersistedUIState, StatusBarDefaultMarker>

export const STATUS_BAR_DEFAULT_MARKER_UPDATE = {
  _portsStatusBarDefaultAdded: true,
  _kimiStatusBarDefaultAdded: true,
  _minimaxStatusBarDefaultAdded: true,
  _antigravityStatusBarDefaultAdded: true,
  _grokStatusBarDefaultAdded: true,
  _cursorStatusBarDefaultAdded: true
} as const

export function migrateStatusBarDefaultItems(
  items: StatusBarItem[],
  state: StatusBarDefaultMigrationState
): StatusBarItem[] {
  return DEFAULT_ON_STATUS_BAR_ITEMS.reduce<StatusBarItem[]>((next, entry) => {
    return state[entry.marker] || next.includes(entry.item) ? next : [...next, entry.item]
  }, items)
}

export function hasPendingStatusBarDefaultMarkers(state: StatusBarDefaultMigrationState): boolean {
  return DEFAULT_ON_STATUS_BAR_ITEMS.some((entry) => !state[entry.marker])
}
