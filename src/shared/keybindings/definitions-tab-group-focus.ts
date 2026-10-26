import type { KeybindingDefinition } from './types'
import { platformBindings } from './definitions-support'

export const TAB_GROUP_FOCUS_DEFINITIONS: readonly KeybindingDefinition[] = [
  {
    id: 'tab.focusNextGroup',
    title: 'Focus next split group',
    group: 'Tab Navigation',
    scope: 'tabs',
    conflictGroup: 'global',
    searchKeywords: ['shortcut', 'tab', 'split', 'group', 'pane', 'focus', 'next'],
    defaultBindings: platformBindings([]),
    allowInTerminal: true,
    allowInTextField: 'non-default-chords'
  },
  {
    id: 'tab.focusPreviousGroup',
    title: 'Focus previous split group',
    group: 'Tab Navigation',
    scope: 'tabs',
    conflictGroup: 'global',
    searchKeywords: ['shortcut', 'tab', 'split', 'group', 'pane', 'focus', 'previous'],
    defaultBindings: platformBindings([]),
    allowInTerminal: true,
    allowInTextField: 'non-default-chords'
  }
]
