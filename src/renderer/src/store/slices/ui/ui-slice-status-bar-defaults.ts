import type { PersistedUIState } from '../../../../../shared/persisted-ui-state-types'
import type { StatusBarItem } from '../../../../../shared/ui-chrome-types'

const STATUS_BAR_DEFAULTS = [
  ['ports', '_portsStatusBarDefaultAdded'],
  ['kimi', '_kimiStatusBarDefaultAdded'],
  ['minimax', '_minimaxStatusBarDefaultAdded'],
  ['antigravity', '_antigravityStatusBarDefaultAdded'],
  ['grok', '_grokStatusBarDefaultAdded'],
  ['kiro', '_kiroStatusBarDefaultAdded']
] as const satisfies readonly (readonly [StatusBarItem, keyof PersistedUIState])[]

export const STATUS_BAR_DEFAULT_MARKERS = {
  _portsStatusBarDefaultAdded: true,
  _kimiStatusBarDefaultAdded: true,
  _minimaxStatusBarDefaultAdded: true,
  _antigravityStatusBarDefaultAdded: true,
  _grokStatusBarDefaultAdded: true,
  _kiroStatusBarDefaultAdded: true
} as const

export function addMissingStatusBarDefaults(
  ui: PersistedUIState,
  items: StatusBarItem[]
): StatusBarItem[] {
  let result = items
  for (const [item, marker] of STATUS_BAR_DEFAULTS) {
    if (ui[marker] !== true && !result.includes(item)) {
      result = [...result, item]
    }
  }
  return result
}

export function hasUnpersistedStatusBarDefaults(ui: PersistedUIState): boolean {
  return STATUS_BAR_DEFAULTS.some(([, marker]) => ui[marker] !== true)
}
