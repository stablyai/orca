import type { PaneManager } from '@/lib/pane-manager/pane-manager'

const NATIVE_CHAT_COVER_SELECTOR = '.native-chat-pane-shell'

/**
 * Leaf container selector that excludes panes whose xterm sits under the native
 * chat portal. Chat mode is a tab flag, but only the chat leaf's xterm is
 * covered — a split terminal leaf in the same tab must still take focus.
 */
export const UNCOVERED_TERMINAL_LEAF_SELECTOR = `[data-leaf-id]:not(:has(${NATIVE_CHAT_COVER_SELECTOR}))`

export function paneIsCoveredByNativeChat(
  pane: { container: Pick<Element, 'querySelector'> } | null | undefined
): boolean {
  return pane?.container.querySelector(NATIVE_CHAT_COVER_SELECTOR) != null
}

/**
 * Pane focus aimed at a covered pane lands on its chat cover (the chat then hands
 * it to its composer), never on the hidden terminal or the pane the user left.
 * Returns false when no chat covers the pane.
 */
export function focusNativeChatCover(pane: { container: Pick<Element, 'querySelector'> }): boolean {
  const cover = pane.container.querySelector<HTMLElement>(NATIVE_CHAT_COVER_SELECTOR)
  if (!cover) {
    return false
  }
  // Focus already in the chat (a click, the composer) stays where it is.
  if (!cover.contains(cover.ownerDocument.activeElement)) {
    cover.focus({ preventScroll: true })
  }
  return true
}

/** True for anything inside a chat cover, including the shell before a chat root mounts. */
export function isInsideNativeChatCover(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(NATIVE_CHAT_COVER_SELECTOR) !== null
}

/** Mirrors focusActivePane's target so the guard tracks exactly the pane that would take focus. */
export function activePaneIsCoveredByNativeChat(manager: PaneManager): boolean {
  return paneIsCoveredByNativeChat(manager.getActivePane() ?? manager.getPanes()[0])
}
