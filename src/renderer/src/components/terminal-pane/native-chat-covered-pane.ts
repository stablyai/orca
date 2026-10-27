import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { focusNativeChatPromptCard } from '../native-chat/use-native-chat-prompt-card-focus'

const NATIVE_CHAT_COVER_SELECTOR = '.native-chat-pane-shell'

/** Exclude only the chat-covered leaf; sibling terminal leaves in the same chat-mode tab still accept focus. */
export const UNCOVERED_TERMINAL_LEAF_SELECTOR = `[data-leaf-id]:not(:has(${NATIVE_CHAT_COVER_SELECTOR}))`

export function paneIsCoveredByNativeChat(
  pane: { container: Pick<Element, 'querySelector'> } | null | undefined
): boolean {
  return pane?.container.querySelector(NATIVE_CHAT_COVER_SELECTOR) != null
}

/** Focus the covered leaf’s chat, which forwards to its composer; return false if the leaf has no chat cover. */
export function focusNativeChatCover(pane: { container: Pick<Element, 'querySelector'> }): boolean {
  const cover = pane.container.querySelector<HTMLElement>(NATIVE_CHAT_COVER_SELECTOR)
  if (!cover) {
    return false
  }
  const active = cover.ownerDocument.activeElement
  if (active === cover || !cover.contains(active)) {
    if (!focusNativeChatPromptCard(cover, null)) {
      cover.focus({ preventScroll: true })
    }
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
