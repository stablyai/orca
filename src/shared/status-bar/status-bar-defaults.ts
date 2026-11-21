import type { PersistedUIState } from '../orca-profiles/persisted-ui-state-types'
import type { StatusBarItem } from '../ui-chrome/ui-chrome-types'

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
  'ports',
  'git-blame'
]

/** One-time additions for profiles saved before the item joined the default list. */
const DEFAULT_ON_STATUS_BAR_ITEMS = [
  ['_portsStatusBarDefaultAdded', 'ports'],
  ['_kimiStatusBarDefaultAdded', 'kimi'],
  ['_minimaxStatusBarDefaultAdded', 'minimax'],
  ['_antigravityStatusBarDefaultAdded', 'antigravity'],
  ['_grokStatusBarDefaultAdded', 'grok'],
  ['_cursorStatusBarDefaultAdded', 'cursor'],
  ['_zcodeStatusBarDefaultAdded', 'zcode'],
  ['_museStatusBarDefaultAdded', 'muse'],
  ['_gitBlameStatusBarDefaultAdded', 'git-blame']
] as const satisfies readonly (readonly [keyof PersistedUIState, StatusBarItem])[]

type DefaultOnStatusBarFlag = (typeof DEFAULT_ON_STATUS_BAR_ITEMS)[number][0]

export function migrateStatusBarItems(items: readonly string[] | undefined): StatusBarItem[] {
  const source = Array.isArray(items) ? items : DEFAULT_STATUS_BAR_ITEMS
  const out: string[] = []
  for (const id of source) {
    const mapped = id === 'memory' || id === 'sessions' ? 'resource-usage' : id
    if (!out.includes(mapped)) {
      out.push(mapped)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: saved ids, with retired ones renamed.
  return out as StatusBarItem[]
}

/** Adds each default-on item once; a recorded flag keeps a later removal by the user. */
export function applyDefaultOnStatusBarItems(
  ui: Partial<Pick<PersistedUIState, 'statusBarItems' | DefaultOnStatusBarFlag>> | undefined
): { items: StatusBarItem[]; flags: Record<DefaultOnStatusBarFlag, true>; needsSave: boolean } {
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
  const flags = defaultOnStatusBarFlags()
  return { items, flags, needsSave }
}

export function defaultOnStatusBarFlags(): Record<DefaultOnStatusBarFlag, true> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: one entry per flag.
  return Object.fromEntries(DEFAULT_ON_STATUS_BAR_ITEMS.map(([flag]) => [flag, true])) as Record<
    DefaultOnStatusBarFlag,
    true
  >
}
