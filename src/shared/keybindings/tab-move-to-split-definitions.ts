import type { KeybindingDefinition, TabMoveToSplitActionId } from './types'
import { platformBindings } from './definitions-support'

// The one direction list: Settings rows, shortcut handlers and the tab menu all map over it, in menu order.
export const TAB_MOVE_TO_SPLIT_DIRECTIONS = ['right', 'left', 'down', 'up'] as const

export type TabMoveToSplitDirection = (typeof TAB_MOVE_TO_SPLIT_DIRECTIONS)[number]

export function tabMoveToSplitActionId(direction: TabMoveToSplitDirection): TabMoveToSplitActionId {
  return `tab.moveToSplit.${direction}`
}

/** The direction whose shortcut this event matches, if any. */
export function matchTabMoveToSplitDirection(
  matches: (actionId: TabMoveToSplitActionId) => boolean
): TabMoveToSplitDirection | undefined {
  return TAB_MOVE_TO_SPLIT_DIRECTIONS.find((direction) =>
    matches(tabMoveToSplitActionId(direction))
  )
}

export function buildTabMoveToSplitKeybindingDefinitions(): KeybindingDefinition[] {
  return TAB_MOVE_TO_SPLIT_DIRECTIONS.map((direction) => ({
    id: tabMoveToSplitActionId(direction),
    title: `Move active tab to split ${direction}`,
    group: 'Tabs',
    scope: 'tabs',
    searchKeywords: ['shortcut', 'tab', 'move', 'split', 'pane', direction],
    // Why unbound: four directional chords would collide with existing arrow-key bindings on some platform.
    defaultBindings: platformBindings([])
  }))
}
