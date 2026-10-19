import { useCallback, useLayoutEffect, useRef } from 'react'
import type { NativeChatSendHandle } from './native-chat-runtime-send'

export type NativeChatSendLifecycle = {
  cancelPendingSends: () => void
  trackPendingSend: (handle: NativeChatSendHandle, pendingId?: string) => void
}

export function useNativeChatSendLifecycle(
  terminalTabId: string,
  targetPtyId: string | null,
  onPendingSendCanceled?: (pendingId: string) => void,
  cardOwnership?: {
    /** A prompt card owns the agent's input while the composer stays mounted. */
    inputOwnedByCard: boolean
    /** Settles the echo of a send the card retired; it keeps the user's text visible. */
    onPendingSendRetired?: (pendingId: string) => void
  }
): NativeChatSendLifecycle {
  const pendingSendHandlesRef = useRef(
    new Map<
      NativeChatSendHandle,
      { cleanupTimer: ReturnType<typeof setTimeout> | null; pendingId?: string }
    >()
  )
  const settlePendingSends = useCallback(
    (onSettled?: (pendingId: string) => void, keepInput = false) => {
      for (const [handle, entry] of pendingSendHandlesRef.current) {
        const { cleanupTimer, pendingId } = entry
        if (cleanupTimer !== null) {
          clearTimeout(cleanupTimer)
        }
        handle.cancel(keepInput)
        if (pendingId) {
          onSettled?.(pendingId)
        }
      }
      pendingSendHandlesRef.current.clear()
    },
    []
  )
  const cancelPendingSends = useCallback(
    () => settlePendingSends(onPendingSendCanceled),
    [settlePendingSends, onPendingSendCanceled]
  )
  const trackPendingSend = useCallback((handle: NativeChatSendHandle, pendingId?: string) => {
    const entry = {
      cleanupTimer: null as ReturnType<typeof setTimeout> | null,
      ...(pendingId ? { pendingId } : {})
    }
    pendingSendHandlesRef.current.set(handle, entry)
    if (handle.settled) {
      void handle.settled.then(() => {
        if (pendingSendHandlesRef.current.get(handle) === entry) {
          pendingSendHandlesRef.current.delete(handle)
        }
      })
      return
    }
    entry.cleanupTimer = setTimeout(() => {
      pendingSendHandlesRef.current.delete(handle)
    }, handle.settleAfterMs)
  }, [])

  // Why: delayed Enter/image writes belong to the exact PTY target. A pane
  // swap or unmount must cancel them before that PTY can close or be reused.
  useLayoutEffect(() => cancelPendingSends, [cancelPendingSends, targetPtyId, terminalTabId])

  const inputOwnedByCard = cardOwnership?.inputOwnedByCard === true
  const onPendingSendRetired = cardOwnership?.onPendingSendRetired ?? onPendingSendCanceled
  // Why: once a card owns the agent's input, an unsubmitted Enter would answer it. No line clear
  // either: it would type under the dialog, and the next send clears the line first.
  useLayoutEffect(() => {
    if (inputOwnedByCard) {
      settlePendingSends(onPendingSendRetired, true)
    }
  }, [inputOwnedByCard, onPendingSendRetired, settlePendingSends])

  return { cancelPendingSends, trackPendingSend }
}
