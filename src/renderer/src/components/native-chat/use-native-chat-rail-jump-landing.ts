// Pin before layout; scrollMessageToTop releases the bottom pin so streaming cannot undo the jump; release once to avoid repeated scrolling or blocking diff reveals.

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
    onActivate(railJump.messageId)
    release(null)
  }, [onActivate, railJump, release, scrollMessageToTop, scrollRef, slots])
}
