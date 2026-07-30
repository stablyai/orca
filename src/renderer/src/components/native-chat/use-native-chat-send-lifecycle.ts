import { useCallback, useLayoutEffect, useRef } from 'react'
import type { NativeChatSendHandle } from './native-chat-runtime-send'

export type NativeChatSendLifecycle = {
  cancelPendingSends: () => void
  trackPendingSend: (handle: NativeChatSendHandle, pendingId?: string) => void
}

export function useNativeChatSendLifecycle(
  terminalTabId: string,
  targetPtyId: string | null,
  onPendingSendCanceled?: (pendingId: string) => void
): NativeChatSendLifecycle {
  const pendingSendHandlesRef = useRef(
    new Map<
      NativeChatSendHandle,
      { cleanupTimer: ReturnType<typeof setTimeout> | null; pendingId?: string }
    >()
  )
  const cancelPendingSends = useCallback(() => {
    for (const [handle, entry] of pendingSendHandlesRef.current) {
      const { cleanupTimer, pendingId } = entry
      if (cleanupTimer !== null) {
        clearTimeout(cleanupTimer)
      }
      handle.cancel()
      if (pendingId) {
        onPendingSendCanceled?.(pendingId)
      }
    }
    pendingSendHandlesRef.current.clear()
  }, [onPendingSendCanceled])
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

  return { cancelPendingSends, trackPendingSend }
}
