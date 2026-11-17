import type { KeybindingActionId, KeybindingDefinition } from './types'
import { platformBindings } from './definitions-support'

// The one direction table: Settings rows, shortcut handlers and the tab menu all map over it, in menu order.
export const TAB_MOVE_TO_SPLIT_ACTIONS = [
  { direction: 'right', id: 'tab.moveToSplitRight' },
  { direction: 'left', id: 'tab.moveToSplitLeft' },
  { direction: 'down', id: 'tab.moveToSplitDown' },
  { direction: 'up', id: 'tab.moveToSplitUp' }
] as const satisfies readonly { direction: string; id: KeybindingActionId }[]

export type TabMoveToSplitAction = (typeof TAB_MOVE_TO_SPLIT_ACTIONS)[number]
export type TabMoveToSplitDirection = TabMoveToSplitAction['direction']

/** The move-to-split action whose shortcut this event matches, if any. */
export function matchTabMoveToSplitAction(
  matches: (actionId: KeybindingActionId) => boolean
): TabMoveToSplitAction | undefined {
  return TAB_MOVE_TO_SPLIT_ACTIONS.find(({ id }) => matches(id))
}

export function buildTabMoveToSplitKeybindingDefinitions(): KeybindingDefinition[] {
  return TAB_MOVE_TO_SPLIT_ACTIONS.map(({ direction, id }) => ({
    id,
    title: `Move active tab to split ${direction}`,
    group: 'Tabs',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'move', 'split', 'pane', direction],
    // Why unbound: four directional chords would collide with existing arrow-key bindings on some platform.
    defaultBindings: platformBindings([])
  }))
}
