import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { isInsideNativeChatCover } from '../../chat/native-chat-covered-pane'

/** Resolve keyboard ownership from the focused xterm surface, or the chat covering it, before using manager state. */
export function resolveTerminalKeyboardPane(
  manager: Pick<PaneManager, 'getActivePane' | 'getPanes'>,
  target: EventTarget | null
): ManagedPane | null {
  if (typeof Node !== 'undefined' && target instanceof Node) {
    const inChatCover = isInsideNativeChatCover(target)
    const focusedPane = manager
      .getPanes()
      .find(
        (pane) => (inChatCover ? pane.container : pane.terminal.element)?.contains(target) === true
      )
    if (focusedPane) {
      return focusedPane
    }
  }
  return manager.getActivePane() ?? manager.getPanes()[0] ?? null
}

export function synchronizeTerminalKeyboardPane(
  manager: Pick<PaneManager, 'getActivePane' | 'getPanes' | 'setActivePane'>,
  target: EventTarget | null
): ManagedPane | null {
  const pane = resolveTerminalKeyboardPane(manager, target)
  if (pane && manager.getActivePane()?.id !== pane.id) {
    manager.setActivePane(pane.id, { focus: false })
  }
  return pane
}
