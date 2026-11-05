import { useLayoutEffect, type RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import { focusNativeChatPromptCard } from '../native-chat/use-native-chat-prompt-card-focus'

/** Commit focus to the visible chat cover before making xterm inert, preventing later terminal.focus from sending keys to a hidden agent. */
export function useCoveredTerminalFocusHandoff(
  coverRef: RefObject<HTMLElement | null>,
  terminal: Pick<Terminal, 'element' | 'focus'>
): void {
  useLayoutEffect(() => {
    const cover = coverRef.current
    const terminalElement = terminal.element
    if (!cover || !terminalElement) {
      return
    }
    const ownerDocument = cover.ownerDocument
    // Focus first: making a focused element inert drops focus to <body>.
    if (terminalElement.contains(ownerDocument.activeElement)) {
      if (!focusNativeChatPromptCard(cover, null)) {
        cover.focus({ preventScroll: true })
      }
    }
    terminalElement.inert = true
    return () => {
      terminalElement.inert = false
      // Unmount cleanup runs before React detaches the cover, so this still sees chat focus.
      if (cover.contains(ownerDocument.activeElement)) {
        terminal.focus()
      }
    }
  }, [coverRef, terminal])
}
