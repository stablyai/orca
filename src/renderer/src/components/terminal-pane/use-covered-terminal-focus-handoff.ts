import { useLayoutEffect, type RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'

/**
 * A terminal under a chat cover must never hold focus: its keys would reach an
 * agent the user cannot see. Hands focus to the cover in the commit that mounts
 * it, then marks the xterm inert so no later terminal.focus() can take it back.
 */
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
      cover.focus({ preventScroll: true })
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
