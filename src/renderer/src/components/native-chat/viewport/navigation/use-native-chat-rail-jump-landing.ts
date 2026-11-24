// Pin before layout; scrollMessageToTop releases the bottom pin so streaming cannot undo the jump; release once to avoid repeated scrolling or blocking diff reveals.

import { useLayoutEffect, useRef } from 'react'
import { nativeChatSlotIndexOf } from '../../conversation/slots/native-chat-transcript-slot-selection'
import type { NativeChatTranscriptSlot } from '../../conversation/slots/native-chat-transcript-slots'

/** The transcript window's own slot row; an expanded tool run nests rows with the same `data-index`. */
export function nativeChatTranscriptSlotRow(
  scrollRoot: HTMLElement | null,
  index: number
): HTMLElement | null {
  const transcriptWindow = scrollRoot?.querySelector('[data-native-chat-window]')
  for (const child of transcriptWindow?.children ?? []) {
    if (child instanceof HTMLElement && child.dataset.index === String(index)) {
      return child
    }
  }
  return null
}

export function useNativeChatRailJumpLanding({
  railJump,
  slots,
  scrollRef,
  scrollMessageToTop,
  onActivate,
  onScroll,
  release
}: {
  railJump: { messageId: string; requestId: number } | null
  slots: readonly NativeChatTranscriptSlot[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  scrollMessageToTop: (element: HTMLElement) => void
  onActivate: (id: string) => void
  onScroll?: () => void
  release: (request: null) => void
}): void {
  const servicedRef = useRef(0)
  useLayoutEffect(() => {
    if (railJump === null || servicedRef.current === railJump.requestId) {
      return
    }
    servicedRef.current = railJump.requestId
    const index = nativeChatSlotIndexOf(slots, railJump.messageId)
    // The message left the transcript: nothing to scroll to or light.
    if (index < 0) {
      release(null)
      return
    }
    const row = nativeChatTranscriptSlotRow(scrollRef.current, index)
    if (row) {
      onScroll?.()
      scrollMessageToTop(row)
    }
    onActivate(railJump.messageId)
    release(null)
  }, [onActivate, onScroll, railJump, release, scrollMessageToTop, scrollRef, slots])
}
