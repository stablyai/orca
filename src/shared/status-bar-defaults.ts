import type { PersistedUIState } from './persisted-ui-state-types'
import type { StatusBarItem } from './ui-chrome-types'

export const DEFAULT_STATUS_BAR_ITEMS: StatusBarItem[] = [
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'opencode-go',
  'kimi',
  'minimax',
  'grok',
  'cursor',
  'zcode',
  'muse',
  'ssh',
  'resource-usage',
  'ports'
]

/** One-time additions for profiles saved before the item joined the default list. */
export const DEFAULT_ON_STATUS_BAR_ITEMS = [
  ['_portsStatusBarDefaultAdded', 'ports'],
  ['_kimiStatusBarDefaultAdded', 'kimi'],
  ['_minimaxStatusBarDefaultAdded', 'minimax'],
  ['_antigravityStatusBarDefaultAdded', 'antigravity'],
  ['_grokStatusBarDefaultAdded', 'grok'],
  ['_cursorStatusBarDefaultAdded', 'cursor'],
  ['_zcodeStatusBarDefaultAdded', 'zcode'],
  ['_museStatusBarDefaultAdded', 'muse']
] as const

type DefaultOnStatusBarFlag = (typeof DEFAULT_ON_STATUS_BAR_ITEMS)[number][0]

type StatusBarDefaultSource = Partial<
  Pick<PersistedUIState, 'statusBarItems' | DefaultOnStatusBarFlag>
>

export function migrateStatusBarItems(items: readonly string[] | undefined): StatusBarItem[] {
  const source = items ?? DEFAULT_STATUS_BAR_ITEMS
  const out: string[] = []
  for (const id of source) {
    const mapped = id === 'memory' || id === 'sessions' ? 'resource-usage' : id
    if (!out.includes(mapped)) {
      out.push(mapped)
    }
  }
  return out as StatusBarItem[]
}

/** Adds each default-on item once. A recorded flag keeps a later user removal. */
export function applyDefaultOnStatusBarItems(ui: StatusBarDefaultSource | undefined): {
  items: StatusBarItem[]
  needsSave: boolean
} {
  let items = migrateStatusBarItems(ui?.statusBarItems)
  let needsSave = false
  for (const [flag, item] of DEFAULT_ON_STATUS_BAR_ITEMS) {
    if (ui?.[flag] === true) {
      continue
    }
    needsSave = true
    if (!items.includes(item)) {
      items = [...items, item]
    }
  }
  return { items, needsSave }
}

export function defaultOnStatusBarFlagPatch(): Record<DefaultOnStatusBarFlag, true> {
  return {
    _portsStatusBarDefaultAdded: true,
    _kimiStatusBarDefaultAdded: true,
    _minimaxStatusBarDefaultAdded: true,
    _antigravityStatusBarDefaultAdded: true,
    _grokStatusBarDefaultAdded: true,
    _cursorStatusBarDefaultAdded: true,
    _zcodeStatusBarDefaultAdded: true,
    _museStatusBarDefaultAdded: true
  }
}
