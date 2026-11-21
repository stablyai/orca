import { createContext, useCallback, useLayoutEffect, type RefObject } from 'react'
import { nativeChatSlotIndexOf } from '../conversation/slots/native-chat-transcript-slot-selection'
import type { NativeChatTranscriptSlot } from '../conversation/slots/native-chat-transcript-slots'
import type { NativeChatNavigationRequest } from '../viewport/navigation/use-native-chat-transcript-navigation'
import type { useNativeChatHistoryJump } from '../viewport/navigation/use-native-chat-history-jump'
import { showQuotedText } from './native-chat-quote-highlight'
import type { NativeChatQuoteJumpDeps } from './native-chat-quote-sources'

export type NativeChatQuoteJump = NonNullable<NativeChatQuoteJumpDeps['jumpToMessage']>

// About half a second: the landing draws a loaded row well before this.
const SOURCE_FRAMES = 30

/** The transcript's jump to a quoted message; null outside a transcript. */
export const NativeChatQuoteJumpContext = createContext<NativeChatQuoteJump | null>(null)

/**
 * Scrolls to the message as a rail jump does, then shows the quoted text in it. A message that is
 * not loaded is paged in from older history first, as a link to a message is.
 */
export function useNativeChatQuoteJump({
  slots,
  scrollRef,
  request,
  beginNavigation,
  readerLeavesEnd,
  startHistoryJump,
  sessionKey
}: {
  slots: readonly NativeChatTranscriptSlot[]
  scrollRef: RefObject<HTMLDivElement | null>
  request: Pick<NativeChatNavigationRequest, 'issue' | 'nextRequestId'>
  beginNavigation: () => void
  readerLeavesEnd: () => void
  startHistoryJump: ReturnType<typeof useNativeChatHistoryJump>['start']
  /** This chat; a source from another chat that is not loaded here pages nothing. */
  sessionKey: string
}): NativeChatQuoteJump {
  const { issue, nextRequestId } = request
  // "Add to chat" reads the chat of a quote from its transcript's scroller.
  useLayoutEffect(() => {
    scrollRef.current?.setAttribute('data-native-chat-quote-chat', sessionKey)
  })
  return useCallback(
    ({ messageId, place, chat }, text, notifyMissing, isCurrent) => {
      const loaded = nativeChatSlotIndexOf(slots, messageId) !== -1
      // A loaded message is here whatever its chat; the chat only rules out paging this chat.
      if (!loaded && chat !== undefined && chat !== sessionKey) {
        return false
      }
      beginNavigation()
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
      if (loaded) {
        readerLeavesEnd()
        issue({ kind: 'rail', messageId, requestId: nextRequestId() })
        // The landing scrolls in a layout effect; the row is drawn two frames later or more.
        requestAnimationFrame(showWhenDrawn)
        return true
      }
      // A long chat keeps only its latest messages loaded, for example after a send. The link landing
      // takes the reader off the end.
      startHistoryJump({ kind: 'item', id: messageId }, (result) => {
        if (result === 'landed') {
          requestAnimationFrame(showWhenDrawn)
        } else if (result === 'missing' && isCurrent()) {
          notifyMissing()
        }
      })
      return true
    },
    [
      beginNavigation,
      issue,
      nextRequestId,
      readerLeavesEnd,
      scrollRef,
      sessionKey,
      slots,
      startHistoryJump
    ]
  )
}
