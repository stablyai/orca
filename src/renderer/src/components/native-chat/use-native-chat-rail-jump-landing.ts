// Carrying out a rail jump to a loaded message: scroll its row to the top, light
// its tick, release the request.
//
// Pinning the target mounts it in the same commit, so the row exists by the time
// layout runs. Routed through `scrollMessageToTop` rather than the virtualizer
// because that is what releases the bottom pin — without it the next streamed
// token snaps the reader straight back down.
//
// Serviced once per request, then released. `slots` takes a new identity on
// every render, so an effect that merely depended on it would re-scroll to this
// row forever; and a request left standing would keep its pin, which outranks
// the diff reveal that shares it.

import { useLayoutEffect, useRef } from 'react'
import {
  nativeChatSlotIndexOf,
  type NativeChatTranscriptSlot
} from './native-chat-transcript-slots'

export function useNativeChatRailJumpLanding({
  railJump,
  slots,
  scrollRef,
  scrollMessageToTop,
  onActivate,
  release
}: {
  railJump: { messageId: string; requestId: number } | null
  slots: readonly NativeChatTranscriptSlot[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  scrollMessageToTop: (element: HTMLElement) => void
  onActivate: (id: string) => void
  release: (request: null) => void
}): void {
  const servicedRef = useRef(0)
  useLayoutEffect(() => {
    if (railJump === null || servicedRef.current === railJump.requestId) {
      return
    }
    servicedRef.current = railJump.requestId
    const index = nativeChatSlotIndexOf(slots, railJump.messageId)
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)
    if (row) {
      scrollMessageToTop(row)
    }
    // Lit now: the scroll's own position report only arrives once it settles.
    onActivate(railJump.messageId)
    release(null)
  }, [onActivate, railJump, release, scrollMessageToTop, scrollRef, slots])
}
