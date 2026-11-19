import { createContext, useCallback, type RefObject } from 'react'
import { nativeChatSlotIndexOf } from '../conversation/slots/native-chat-transcript-slot-selection'
import type { NativeChatTranscriptSlot } from '../conversation/slots/native-chat-transcript-slots'
import type { NativeChatNavigationRequest } from '../viewport/navigation/use-native-chat-transcript-navigation'
import { showQuotedText } from './native-chat-quote-highlight'
import type { NativeChatQuoteJumpDeps } from './native-chat-quote-sources'

export type NativeChatQuoteJump = NonNullable<NativeChatQuoteJumpDeps['jumpToMessage']>

// About half a second: the landing draws a loaded row well before this.
const SOURCE_FRAMES = 30

/** The transcript's jump to a quoted message; null outside a transcript. */
export const NativeChatQuoteJumpContext = createContext<NativeChatQuoteJump | null>(null)

/** Scrolls to a loaded message as a rail jump does, then shows the quoted text in it. */
export function useNativeChatQuoteJump({
  slots,
  scrollRef,
  request,
  beginNavigation,
  readerLeavesEnd
}: {
  slots: readonly NativeChatTranscriptSlot[]
  scrollRef: RefObject<HTMLDivElement | null>
  request: Pick<NativeChatNavigationRequest, 'issue' | 'nextRequestId'>
  beginNavigation: () => void
  readerLeavesEnd: () => void
}): NativeChatQuoteJump {
  const { issue, nextRequestId } = request
  return useCallback(
    ({ messageId, place }, text, notifyMissing, isCurrent) => {
      const index = nativeChatSlotIndexOf(slots, messageId)
      if (index === -1) {
        return false
      }
      beginNavigation()
      readerLeavesEnd()
      issue({ kind: 'rail', messageId, requestId: nextRequestId() })
      // The landing scrolls in a layout effect; the row is drawn two frames later or more.
      let frame = 0
      const showWhenDrawn = (): void => {
        if (!isCurrent()) {
          return
        }
        frame++
        // By the message id: a tool run's member rows use data-index too.
        const source =
          frame < 2
            ? null
            : scrollRef.current?.querySelector<HTMLElement>(
                `[data-native-chat-quote-source="${CSS.escape(messageId)}"]`
              )
        if (source) {
          showQuotedText(source, text, place)
        } else if (frame < SOURCE_FRAMES) {
          requestAnimationFrame(showWhenDrawn)
        } else {
          notifyMissing()
        }
      }
      requestAnimationFrame(showWhenDrawn)
      return true
    },
    [beginNavigation, issue, nextRequestId, readerLeavesEnd, scrollRef, slots]
  )
}
