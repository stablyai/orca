import { useEffect, useRef, type RefObject } from 'react'
import { PANE_CONTAINER_SELECTOR } from '@/lib/pane-manager/pane-surface-focus'
import { shouldAutofocusNativeChatComposer } from './native-chat-composer-autofocus'
import type { NativeChatComposerHandle } from './NativeChatComposer'

/** Autofocuses the composer when this chat surface becomes active (new
 *  session, switching back to the tab/pane).
 *
 *  One-shot intent: activation arms a pending-focus flag that the first
 *  attempt consumes. The attempt is deferred until the composer is enabled
 *  (pty bound, no mobile presence-lock) and no question card owns the input —
 *  but a later enable flip with the intent already consumed (e.g. a mobile
 *  lock releasing minutes after activation) must not steal focus again.
 *
 *  Why double-rAF: switching FROM another chat tab hides its composer via
 *  display:none, which blurs it back to the browser — but that blur is not
 *  guaranteed to have landed by the time this effect's callback runs (React's
 *  passive effects don't wait for an actual paint, especially for updates
 *  originating outside a DOM event, e.g. the Cmd+Shift+[/] IPC tab-cycle).
 *  Checking activeElement too early sees the old tab's real textarea still
 *  focused and the politeness check correctly-but-wrongly declines to steal
 *  it. Same race focus-terminal-tab-surface.ts already waits out. */
export function useNativeChatComposerAutofocus(args: {
  chatSurfaceActive: boolean
  composerEnabled: boolean
  questionActive: boolean
  rootRef: RefObject<HTMLElement | null>
  composerRef: RefObject<NativeChatComposerHandle | null>
}): void {
  const { chatSurfaceActive, composerEnabled, questionActive, rootRef, composerRef } = args
  const pendingFocusIntentRef = useRef(false)
  const wasActiveRef = useRef(false)
  useEffect(() => {
    if (chatSurfaceActive && !wasActiveRef.current) {
      pendingFocusIntentRef.current = true
    }
    wasActiveRef.current = chatSurfaceActive
    if (!chatSurfaceActive) {
      pendingFocusIntentRef.current = false
      return
    }
    if (!pendingFocusIntentRef.current || !composerEnabled || questionActive) {
      return
    }
    let frameId = requestAnimationFrame(() => {
      frameId = requestAnimationFrame(() => {
        if (!pendingFocusIntentRef.current) {
          return
        }
        // Consumed on attempt either way: a politeness decline (user typing
        // elsewhere) must not turn into a delayed steal on a later dep flip.
        pendingFocusIntentRef.current = false
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
            focusScope: rootRef.current?.closest(PANE_CONTAINER_SELECTOR) ?? rootRef.current
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
