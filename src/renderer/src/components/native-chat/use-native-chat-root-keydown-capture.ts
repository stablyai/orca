import { useCallback, type KeyboardEvent, type RefObject } from 'react'
import {
  shouldFocusNativeChatComposerFromEditingKey,
  shouldRedirectNativeChatTyping
} from './native-chat-typing-redirect'
import type { NativeChatComposerHandle } from './NativeChatComposer'

/** Backspace/Delete outside an input focuses the composer like typing does
 *  (see shouldFocusNativeChatComposerFromEditingKey); printable keys redirect
 *  into the composer via insertTypedText (shouldRedirectNativeChatTyping). */
export function useNativeChatRootKeyDownCapture(
  composerRef: RefObject<NativeChatComposerHandle | null>
): (event: KeyboardEvent<HTMLDivElement>) => void {
  return useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
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
