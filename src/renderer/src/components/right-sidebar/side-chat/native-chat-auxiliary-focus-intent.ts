import { useSyncExternalStore } from 'react'

/** One explicit open route claims focus for exactly the child it selected; a plain panel reopen does not. */
let focusedSessionId: string | null = null
const listeners = new Set<() => void>()

export function requestNativeChatAuxiliaryFocus(sessionId: string): void {
  if (focusedSessionId === sessionId) {
    return
  }
  focusedSessionId = sessionId
  listeners.forEach((listener) => listener())
}

/** Returns true once for the claimed child; later sibling selection is the user's own. */
export function consumeNativeChatAuxiliaryFocus(sessionId: string): boolean {
  if (focusedSessionId !== sessionId) {
    return false
  }
  focusedSessionId = null
  listeners.forEach((listener) => listener())
  return true
}

export function useNativeChatAuxiliaryFocusIntent(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => focusedSessionId,
    () => null
  )
}
