import { createContext, useCallback, useLayoutEffect, type RefObject } from 'react'
import { nativeChatSlotIndexOf } from '../conversation/slots/native-chat-transcript-slot-selection'
import type { NativeChatTranscriptSlot } from '../conversation/slots/native-chat-transcript-slots'
import type { NativeChatNavigationRequest } from '../viewport/navigation/use-native-chat-transcript-navigation'
import type { useNativeChatHistoryJump } from '../viewport/navigation/use-native-chat-history-jump'
import { subscribeLinkOpenRequests } from '@/lib/links/link-open-request'
import { showQuotedText } from './native-chat-quote-highlight'
import type { NativeChatQuoteJumpDeps } from './native-chat-quote-sources'

export type NativeChatQuoteJump = NonNullable<NativeChatQuoteJumpDeps['jumpToMessage']>

// The landing draws a loaded row well before this, whatever the display's frame rate.
const SOURCE_WAIT_MS = 500

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
  sessionKey,
  unfoldTurnOf
}: {
  slots: readonly NativeChatTranscriptSlot[]
  scrollRef: RefObject<HTMLDivElement | null>
  request: Pick<NativeChatNavigationRequest, 'issue' | 'nextRequestId'>
  beginNavigation: () => void
  readerLeavesEnd: () => void
  startHistoryJump: ReturnType<typeof useNativeChatHistoryJump>['start']
  /** This chat; a source from another chat that is not loaded here pages nothing. */
  sessionKey: string
  /** Expands the collapsed turn that hides a loaded message; false when no turn hides it. */
  unfoldTurnOf: (messageId: string) => boolean
}): NativeChatQuoteJump {
  const { issue, nextRequestId } = request
  // "Add to chat" reads the chat of a quote from its transcript's scroller.
  useLayoutEffect(() => {
    scrollRef.current?.setAttribute('data-native-chat-quote-chat', sessionKey)
  })
  return useCallback(
    ({ messageId, place, chat }, text, notifyMissing, isCurrent) => {
      // A collapsed turn draws no text for its message: the history jump lands after the turn expands.
      const folded = unfoldTurnOf(messageId)
      const loaded = !folded && nativeChatSlotIndexOf(slots, messageId) !== -1
      // A loaded message is here whatever its chat; the chat only rules out paging this chat.
      if (!folded && !loaded && chat !== undefined && chat !== sessionKey) {
        return false
      }
      beginNavigation()
      let frame = 0
      let deadline = 0
      const showWhenDrawn = (): void => {
        if (!isCurrent()) {
          return
        }
        frame += 1
        if (deadline === 0) {
          deadline = performance.now() + SOURCE_WAIT_MS
        }
        // By the message id: a tool run's member rows use data-index too.
        const source =
          frame < 2
            ? null
            : scrollRef.current?.querySelector<HTMLElement>(
                `[data-native-chat-quote-source="${CSS.escape(messageId)}"]`
              )
        if (source) {
          showQuotedText(source, text, place)
        } else if (performance.now() < deadline) {
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
      // takes the reader off the end. A newer link open stops the paging before it lands here.
      const stop = subscribeLinkOpenRequests(beginNavigation)
      startHistoryJump({ kind: 'item', id: messageId }, (result) => {
        stop()
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
      startHistoryJump,
      unfoldTurnOf
    ]
  )
}
