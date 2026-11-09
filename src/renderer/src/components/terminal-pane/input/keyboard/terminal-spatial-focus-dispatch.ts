import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import {
  applySpatialPaneFocusKey,
  type SpatialFocusDirection
} from '@/lib/pane-manager/pane-spatial-focus'
import { navigateWorktreeHistoryFromShortcut } from '@/lib/keyboard/worktree-history-shortcut'
import { showTerminalShortcutCaptureNotification } from '@/lib/notifications/terminal-shortcut-capture-notification'
import {
  keybindingMatchesAction,
  type KeybindingPlatform
} from '../../../../../../shared/keybindings'
import { resolveWorktreeHistoryShortcut } from '../../../../../../shared/spatial-pane-shortcut-policy'
import type { KeyboardHandlersDeps } from './terminal-keyboard-dependencies'
import { isInsideNativeChatCover } from '../../chat/native-chat-covered-pane'

type SpatialFocusContext = Pick<
  KeyboardHandlersDeps,
  | 'keybindings'
  | 'terminalShortcutPolicy'
  | 'readUnexpandedLayout'
  | 'expandedPaneIdRef'
  | 'setExpandedPane'
  | 'restoreExpandedLayout'
  | 'refreshPaneSizes'
> & { shortcutPlatform: KeybindingPlatform }

// Why: module-level because a held chord moves focus into another pane's xterm, or another worktree, mid-hold.
let heldChord: { code: string; claim: 'focus' | 'history' | 'pass' } | null = null
const HOLD_MODIFIER_KEYS = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'Shift'])

export function releaseSpatialFocusHold(keyUp?: KeyboardEvent): void {
  // Why: macOS sends no keyup for an arrow released while Cmd is held, so any modifier keyup also ends the hold.
  if (!keyUp || heldChord?.code === keyUp.code || HOLD_MODIFIER_KEYS.has(keyUp.key)) {
    heldChord = null
  }
}

export function dispatchSpatialPaneFocus(
  direction: SpatialFocusDirection,
  event: KeyboardEvent,
  manager: PaneManager,
  context: SpatialFocusContext
): void {
  if (!event.repeat) {
    heldChord = null
  }
  if (event.defaultPrevented) {
    return
  }
  const options = {
    dividerSize: manager.getPaneDividerHitSize(),
    readLayout: context.readUnexpandedLayout,
    beforeFocus: () => {
      if (context.expandedPaneIdRef.current === null) {
        return
      }
      context.restoreExpandedLayout()
      context.setExpandedPane(null)
      context.refreshPaneSizes(false)
    }
  }
  if (event.repeat) {
    // A repeat follows the first press of its hold: a move keeps walking, a pass-through stays with xterm; edges, history and unseen first presses are swallowed.
    const claim = heldChord?.code === event.code ? heldChord.claim : null
    if (
      claim !== 'pass' &&
      !(claim === 'focus' && applySpatialPaneFocusKey(event, manager, direction, options))
    ) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    return
  }
  if (applySpatialPaneFocusKey(event, manager, direction, options)) {
    heldChord = { code: event.code, claim: 'focus' }
    return
  }
  // Why: main matched a chat cover's chords in the app context, so terminal-first keeps its history.
  const fromChatCover = isInsideNativeChatCover(event.target)
  const historyAction = resolveWorktreeHistoryShortcut((actionId) =>
    keybindingMatchesAction(actionId, event, context.shortcutPlatform, context.keybindings, {
      context: fromChatCover ? 'app' : 'terminal',
      terminalShortcutPolicy: context.terminalShortcutPolicy
    })
  )
  if (historyAction === null) {
    heldChord = { code: event.code, claim: 'pass' }
    return
  }
  // Why: main always absorbed a bound history chord, so a declined one must not print CSI 1;7x at the prompt.
  event.preventDefault()
  event.stopImmediatePropagation()
  heldChord = { code: event.code, claim: 'history' }
  // History matches in a terminal only under orca-first, where main showed this notice; never for a chat cover.
  if (
    navigateWorktreeHistoryFromShortcut(
      historyAction === 'worktree.history.back' ? 'back' : 'forward'
    ) &&
    !fromChatCover
  ) {
    showTerminalShortcutCaptureNotification({
      actionId: historyAction,
      platform: context.shortcutPlatform,
      keybindings: context.keybindings
    })
  }
}
