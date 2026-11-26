import { useLayoutEffect, useRef } from 'react'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'

export function useNativeChatRecoveryFocus(
  rootRef: React.RefObject<HTMLDivElement | null>,
  notices: ReadonlyMap<string, NativeChatDeliveryNotice>
): React.RefObject<HTMLSpanElement | null> {
  const live = useRef<HTMLSpanElement>(null)
  const watching = useRef(new Map<string, { typed: boolean }>())
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) {
      return
    }
    const pending = watching.current
    const edited = () => pending.forEach((watch) => (watch.typed = true))
    root.addEventListener('input', edited)
    return () => {
      root.removeEventListener('input', edited)
      pending.clear()
    }
  }, [rootRef])
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) {
      return
    }
    for (const [id, notice] of notices) {
      if (notice.sending && !watching.current.has(id)) {
        watching.current.set(id, { typed: false })
      }
    }
    for (const [id, watch] of watching.current) {
      const notice = notices.get(id)
      if (notice?.sending) {
        continue
      }
      watching.current.delete(id)
      if (!notice?.text || notice.recoveryFocus === undefined) {
        continue
      }
      // Returned cards already announce through the queue's live region.
      if (live.current && !notice.recoveryCardId) {
        live.current.textContent = notice.text
      }
      if (
        !notice.recoveryFocus ||
        watch.typed ||
        root.dataset.nativeChatVisible !== 'true' ||
        document.visibilityState === 'hidden' ||
        !root.contains(document.activeElement)
      ) {
        continue
      }
      const holder = notice.recoveryCardId
        ? [...root.querySelectorAll<HTMLElement>('[data-queued-message-id]')].find(
            (card) => card.dataset.queuedMessageId === notice.recoveryCardId
          )
        : [...root.querySelectorAll<HTMLElement>('[data-native-chat-message-id]')].find(
            (row) => row.dataset.nativeChatMessageId === id
          )
      const send = holder?.querySelector<HTMLButtonElement>('[data-native-chat-retry]')
      if (send && !send.disabled && !send.closest('[hidden]')) {
        send.focus()
      }
    }
  }, [notices, rootRef])
  return live
}
