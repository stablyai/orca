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

  // Cancel delayed Enter/image writes during commit before a swapped PTY can close or be reused.
  useLayoutEffect(() => cancelPendingSends, [cancelPendingSends, targetPtyId, terminalTabId])

  const inputOwnedByCard = cardOwnership?.inputOwnedByCard === true
  const onPendingSendRetired = cardOwnership?.onPendingSendRetired ?? onPendingSendCanceled
  // Card ownership makes a pending Enter an answer; retire it without typing a line-clear under the dialog.
  useLayoutEffect(() => {
    if (inputOwnedByCard) {
      settlePendingSends(onPendingSendRetired, true)
    }
  }, [inputOwnedByCard, onPendingSendRetired, settlePendingSends])

  return { cancelPendingSends, trackPendingSend }
}
