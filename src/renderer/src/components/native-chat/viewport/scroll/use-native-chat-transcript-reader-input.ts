import { useCallback, useMemo } from 'react'
import { useNativeChatRailWake } from '../rail/use-native-chat-rail-wake'
import { useNativeChatReaderScrollInput } from './native-chat-reader-scroll-input'
import type { useNativeChatTranscriptScroll } from './use-native-chat-transcript-scroll'
import type { NativeChatTranscriptWindow } from '../virtualization/use-native-chat-transcript-window'

type TranscriptScroll = Pick<
  ReturnType<typeof useNativeChatTranscriptScroll>,
  'onScroll' | 'recordReaderScroll' | 'readerLeavesEnd' | 'forwardedGesture'
>

/** The transcript scroller's reader input: scrolling wakes the rail, and a reader gesture takes over from jumps and the end pin. */
export function useNativeChatTranscriptReaderInput(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  {
    transcriptScroll,
    transcriptWindow,
    beginNavigation
  }: {
    transcriptScroll: TranscriptScroll
    transcriptWindow: Pick<NativeChatTranscriptWindow, 'cancelAlign' | 'releaseEndPin'>
    beginNavigation: () => void
  }
) {
  const { onScroll, recordReaderScroll, readerLeavesEnd, forwardedGesture } = transcriptScroll
  const { railRef, wake: wakeRail, sustain: sustainRail } = useNativeChatRailWake()
  const onTranscriptScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      onScroll(event)
      sustainRail()
    },
    [onScroll, sustainRail]
  )
  const onReaderScroll = useCallback(() => {
    beginNavigation()
    recordReaderScroll()
    wakeRail()
  }, [beginNavigation, recordReaderScroll, wakeRail])
  const readerInput = useNativeChatReaderScrollInput(scrollRef, {
    onReaderScroll,
    onTakeScroll: transcriptWindow.cancelAlign,
    onReaderAct: transcriptWindow.releaseEndPin,
    onLeaveEnd: readerLeavesEnd,
    onScrollGesture: forwardedGesture
  })
  const scrollerProps = useMemo(
    () => ({ onScroll: onTranscriptScroll, ...readerInput.scrollerProps }),
    [onTranscriptScroll, readerInput.scrollerProps]
  )
  return { ...readerInput, scrollerProps, railRef }
}
