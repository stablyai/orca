import type { KeybindingDefinition } from './types'
import { platformBindings } from './definitions-support'

export const KEYBINDING_DEFINITION_EDITOR_TABS: readonly KeybindingDefinition[] = [
  {
    id: 'tab.togglePin',
    title: 'Pin or unpin active tab',
    group: 'Tabs',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'pin', 'unpin', 'tab', 'keep', 'open'],
    defaultBindings: platformBindings([])
  },
  {
    id: 'tab.saveAndCloseUnpinned',
    title: 'Save and close unpinned tabs',
    group: 'Tabs',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'save', 'close', 'unpinned', 'tabs', 'files', 'editors', 'all'],
    defaultBindings: platformBindings([])
  }
]
