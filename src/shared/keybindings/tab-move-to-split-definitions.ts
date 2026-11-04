import type { KeybindingDefinition } from './types'
import { platformBindings } from './definitions-support'

export const TAB_MOVE_TO_SPLIT_COMMANDS = [
  { id: 'tab.moveToSplitRight', direction: 'right' },
  { id: 'tab.moveToSplitLeft', direction: 'left' },
  { id: 'tab.moveToSplitDown', direction: 'down' },
  { id: 'tab.moveToSplitUp', direction: 'up' }
] as const satisfies readonly {
  id: KeybindingDefinition['id']
  direction: 'right' | 'left' | 'down' | 'up'
}[]

/** Leaves all directions unassigned to avoid claiming four new global chords by default. */
export function buildTabMoveToSplitKeybindingDefinitions(): KeybindingDefinition[] {
  return TAB_MOVE_TO_SPLIT_COMMANDS.map(({ id, direction }) => ({
    id,
    title: `Move tab to split ${direction}`,
    group: 'Tabs',
    scope: 'tabs',
    // Why: these run in global capture, so Settings must warn when an earlier global action owns the chord.
    conflictGroup: 'global',
    searchKeywords: ['shortcut', 'tab', 'split', 'move', direction],
    defaultBindings: platformBindings([])
  }))
}
