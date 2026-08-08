import { useCallback, type KeyboardEvent, type RefObject } from 'react'

import type { NativeChatComposerHandle } from './native-chat-composer-types'
import {
  shouldFocusNativeChatComposerFromEditingKey,
  shouldRedirectNativeChatTyping
} from './native-chat-typing-redirect'

/**
 * Routes stray typing in the chat body into the composer, so the transcript
 * behaves like one big input rather than swallowing keystrokes.
 *
 * The predicates live in `native-chat-typing-redirect`; this owns only the
 * capture-phase wiring, which is what kept the view over its line budget.
 */
export function useNativeChatTypingRedirectHandler(
  composerRef: RefObject<NativeChatComposerHandle | null>
): (event: KeyboardEvent<HTMLDivElement>) => void {
  return useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // Backspace/Delete outside an input focuses the composer (like typing)
      // but inserts nothing — let the now-focused field handle the keystroke.
      if (shouldFocusNativeChatComposerFromEditingKey(event)) {
        composerRef.current?.focus()
        return
      }
      if (!shouldRedirectNativeChatTyping(event)) {
        return
      }
      if (!composerRef.current?.insertTypedText(event.key)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
    },
    [composerRef]
  )
}
