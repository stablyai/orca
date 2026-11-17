import { dispatchWorkspaceTabCommand } from '@/lib/workspace/tabs/workspace-tab-commands'
import {
  matchTabMoveToSplitDirection,
  tabMoveToSplitActionId
} from '../../../shared/keybindings/tab-move-to-split-definitions'
import type { KeybindingActionId } from '../../../shared/keybindings/types'

type TabMoveShortcutContext = {
  event: KeyboardEvent
  floatingWorkspaceFocused: boolean
  matchShortcut: (actionId: KeybindingActionId) => boolean
  notifyTerminalCapture: (actionId: KeybindingActionId) => void
  claimTabSwitch: () => boolean
}

/** Chords that move the focused group's active tab: reorder within the group, or into a new split. */
export function handleTerminalWorkspaceTabMoveShortcut({
  event,
  floatingWorkspaceFocused,
  matchShortcut,
  notifyTerminalCapture,
  claimTabSwitch
}: TabMoveShortcutContext): void {
  const moveTabDirection = matchShortcut('tab.moveRight')
    ? 1
    : matchShortcut('tab.moveLeft')
      ? -1
      : null
  if (moveTabDirection !== null) {
    if (claimTabSwitch()) {
      notifyTerminalCapture(moveTabDirection === 1 ? 'tab.moveRight' : 'tab.moveLeft')
      dispatchWorkspaceTabCommand({
        type: 'move',
        direction: moveTabDirection,
        floatingPanelOwned: floatingWorkspaceFocused
      })
    }
    return
  }
  const splitDirection = event.repeat ? undefined : matchTabMoveToSplitDirection(matchShortcut)
  // Claim the chord only when a tab moved, so an unmovable layout lets it reach the focused surface.
  if (
    splitDirection &&
    dispatchWorkspaceTabCommand({
      type: 'move-to-split',
      direction: splitDirection,
      floatingPanelOwned: floatingWorkspaceFocused
    })
  ) {
    event.preventDefault()
    notifyTerminalCapture(tabMoveToSplitActionId(splitDirection))
  }
}
