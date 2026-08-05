import { useEffect, type RefObject } from 'react'
import { shouldAutofocusNativeChatComposer } from './native-chat-composer-autofocus'
import type { NativeChatComposerHandle } from './NativeChatComposer'

/** Autofocuses the composer on new-session launch and on switching back to
 *  this chat tab/pane; retries once the pty binds or a question card closes. */
export function useNativeChatComposerAutofocus(args: {
  chatSurfaceActive: boolean
  composerEnabled: boolean
  questionActive: boolean
  rootRef: RefObject<HTMLElement | null>
  composerRef: RefObject<NativeChatComposerHandle | null>
}): void {
  const { chatSurfaceActive, composerEnabled, questionActive, rootRef, composerRef } = args
  useEffect(() => {
    if (
      !shouldAutofocusNativeChatComposer({
        chatSurfaceActive,
        composerEnabled,
        activeElement: typeof document === 'undefined' ? null : document.activeElement,
        body: typeof document === 'undefined' ? undefined : document.body,
        focusScope: rootRef.current
      })
    ) {
      return
    }
    composerRef.current?.focus()
    // Why: activeElement/focusScope are read fresh at trigger time, not tracked reactively.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatSurfaceActive, composerEnabled, questionActive])
}
