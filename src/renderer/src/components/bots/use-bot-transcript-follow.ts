import { useCallback, useMemo, useRef, useState } from 'react'
import { createProgrammaticScrollMarks } from '@/lib/list-interaction/virtualized-scrolling/programmatic-scroll-marks'
import {
  geometryOf,
  isNearBottom,
  NATIVE_CHAT_FOLLOW_REARM_PX,
  type ScrollGeometry
} from '../native-chat/viewport/scroll/native-chat-autoscroll'
import { useNativeChatReaderScrollInput } from '../native-chat/viewport/scroll/native-chat-reader-scroll-input'
import { useNativeChatToolRunScroll } from '../native-chat/viewport/scroll/native-chat-transcript-scroll-context'
import { useNativeChatTranscriptScroll } from '../native-chat/viewport/scroll/use-native-chat-transcript-scroll'
import { useBotTranscriptReaderAnchor } from './use-bot-transcript-reader-anchor'

function noop(): void {}

function noCopyText(): null {
  return null
}

/** Native chat's follow policy on an unwindowed bot list (a room's transcript, an item's activity):
 * every scroll write is marked as Orca's own. */
export function useBotTranscriptFollow({
  messageCopyText,
  preserveReaderOnViewportResize = false,
  ...input
}: {
  itemCount: number
  isWorking: boolean
  isVisible: boolean
  preserveReaderOnViewportResize?: boolean
  messageCopyText?: (messageId: string) => string | null
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [marks] = useState(createProgrammaticScrollMarks)
  const scrollTo = useCallback(
    (offset: number) => {
      const element = scrollRef.current
      const previous = element?.scrollTop
      if (element) {
        element.scrollTop = offset
      }
      if (element && element.scrollTop !== previous) {
        marks.mark(element.scrollTop)
      }
    },
    [marks]
  )
  const scroll = useNativeChatTranscriptScroll({
    scrollRef,
    contentRef,
    ...input,
    showsTailRow: false,
    alignToViewportTop: useCallback(
      (row: HTMLElement) =>
        scrollTo(
          row.getBoundingClientRect().top -
            (scrollRef.current?.getBoundingClientRect().top ?? 0) +
            (scrollRef.current?.scrollTop ?? 0)
        ),
      [scrollTo]
    ),
    isAlignPending: useCallback(() => false, []),
    scrollToEnd: useCallback(() => scrollTo(scrollRef.current?.scrollHeight ?? 0), [scrollTo]),
    restoreScrollOffset: scrollTo,
    consumeProgrammaticScroll: useCallback(
      (event: Event, previous: ScrollGeometry | null) => {
        const element = scrollRef.current
        if (!element) {
          return false
        }
        const geometry = geometryOf(element)
        const marked = marks.consume(
          event,
          geometry.scrollTop,
          Math.max(0, geometry.scrollHeight - geometry.clientHeight)
        )
        // Growing the viewport can clamp it to the tail without any reader input.
        return (
          marked ||
          (preserveReaderOnViewportResize &&
            previous !== null &&
            geometry.clientHeight > previous.clientHeight &&
            geometry.scrollTop < previous.scrollTop &&
            isNearBottom(geometry, NATIVE_CHAT_FOLLOW_REARM_PX))
        )
      },
      [marks, preserveReaderOnViewportResize]
    ),
    reconcileReaderScroll: noop
  })
  const toolRunScroll = useNativeChatToolRunScroll(
    scrollRef,
    input.isVisible,
    { markProgrammaticScroll: marks.mark },
    scroll
  )
  const { record: recordAnchor, clear: clearAnchor } = useBotTranscriptReaderAnchor({
    scrollRef,
    contentRef,
    readerAtEnd: scroll.readerAtEnd,
    scrollTo
  })
  const leaveEnd = scroll.readerLeavesEnd
  const revealRow = useCallback(
    (row: HTMLElement, behavior: ScrollBehavior): void => {
      leaveEnd()
      clearAnchor()
      row.scrollIntoView({ block: 'start', behavior })
    },
    [clearAnchor, leaveEnd]
  )
  const followScroll = scroll.onScroll
  const onScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      followScroll(event)
      recordAnchor()
    },
    [followScroll, recordAnchor]
  )
  const reader = useNativeChatReaderScrollInput(scrollRef, {
    onReaderScroll: noop,
    onLeaveEnd: scroll.readerLeavesEnd,
    onScrollGesture: scroll.forwardedGesture
  })
  const transcriptRef = useMemo(
    () => ({
      current: {
        revealFindMatch: reader.revealFindMatch,
        messageCopyText: messageCopyText ?? noCopyText
      }
    }),
    [reader.revealFindMatch, messageCopyText]
  )
  return {
    scrollRef,
    contentRef,
    scrollerProps: { ...reader.scrollerProps, onScroll },
    toolRunScroll,
    showJump: scroll.showJump,
    jumpToLatest: scroll.scrollToBottom,
    revealRow,
    forwardedGesture: reader.forwardedGesture,
    transcriptRef,
    scrollMessageToTop: scroll.scrollMessageToTop
  }
}
