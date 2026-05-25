import { KEYBINDING_DEFINITIONS } from '../../../../shared/keybindings'
import type { SettingsSearchEntry } from './settings-search'

export const TERMINAL_SHORTCUT_POLICY_SEARCH_ENTRY: SettingsSearchEntry = {
  title: 'Shortcuts in Terminal',
  description: 'Choose whether Orca or the focused terminal wins when shortcuts overlap.',
  keywords: [
    'shortcut',
    'keyboard',
    'terminal',
    'tui',
    'shell',
    'agent',
    'conflict',
    'orca first',
    'terminal first'
  ]
}

export const SHORTCUTS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  ...KEYBINDING_DEFINITIONS.map((item) => ({
    title: item.title,
    description: `${item.group} shortcut`,
    keywords: [...item.searchKeywords]
  })),
  TERMINAL_SHORTCUT_POLICY_SEARCH_ENTRY
]
