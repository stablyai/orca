import { useEffect, type RefObject } from 'react'
import { shouldAutofocusNativeChatComposer } from './native-chat-composer-autofocus'
import type { NativeChatComposerHandle } from './NativeChatComposer'

/** Autofocuses the composer on new-session launch and on switching back to
 *  this chat tab/pane; retries once the pty binds or a question card closes.
 *
 *  Why double-rAF: switching FROM another chat tab hides its composer via
 *  display:none, which blurs it back to the browser — but that blur is not
 *  guaranteed to have landed by the time this effect's callback runs (React's
 *  passive effects don't wait for an actual paint, especially for updates
 *  originating outside a DOM event, e.g. the Cmd+Shift+[/] IPC tab-cycle).
 *  Checking activeElement too early sees the old tab's real textarea still
 *  focused and its politeness check correctly-but-wrongly declines to steal
 *  it. Same race focus-terminal-tab-surface.ts already waits out. */
export function useNativeChatComposerAutofocus(args: {
  chatSurfaceActive: boolean
  composerEnabled: boolean
  questionActive: boolean
  rootRef: RefObject<HTMLElement | null>
  composerRef: RefObject<NativeChatComposerHandle | null>
}): void {
  const { chatSurfaceActive, composerEnabled, questionActive, rootRef, composerRef } = args
  useEffect(() => {
    if (!chatSurfaceActive || !composerEnabled) {
      return
    }
    let frameId = requestAnimationFrame(() => {
      frameId = requestAnimationFrame(() => {
        if (
          !shouldAutofocusNativeChatComposer({
            chatSurfaceActive,
            composerEnabled,
            activeElement: typeof document === 'undefined' ? null : document.activeElement,
            body: typeof document === 'undefined' ? undefined : document.body,
            // Why: the composer overlay is a DOM sibling of the xterm container
            // (both children of .pane), not an ancestor of the helper textarea —
            // scope the politeness check to .pane so this same pane's xterm is
            // recognized as stealable, not mistaken for a focus elsewhere.
            focusScope: rootRef.current?.closest('.pane') ?? rootRef.current
          })
        ) {
          return
        }
        composerRef.current?.focus()
      })
    })
    return () => cancelAnimationFrame(frameId)
    // Why: activeElement/focusScope are read fresh at trigger time, not tracked reactively.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatSurfaceActive, composerEnabled, questionActive])
}
