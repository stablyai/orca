import type { RefObject, UIEventHandler } from 'react'
import type { ReaderGesture } from './native-chat-autoscroll'

export type NativeChatTranscriptScrollOptions = {
  scrollRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  itemCount: number
  isWorking: boolean
  /** Whether the list draws a row after the transcript (live activity or a wait). */
  showsTailRow: boolean
  isVisible: boolean
  alignToViewportTop: (element: HTMLElement) => void
  isAlignPending: () => boolean
  scrollToEnd: () => void
  restoreScrollOffset: (offset: number) => void
  consumeProgrammaticScroll: (event: Event) => boolean
  reconcileReaderScroll: (isTakingOver: boolean) => void
}

export type NativeChatTranscriptScroll = {
  showJump: boolean
  onScroll: UIEventHandler<HTMLDivElement>
  scrollToBottom: () => void
  scrollMessageToTop: (element: HTMLElement) => void
  /** A reader gesture left the end: the only thing besides a row jump that stops following. */
  readerLeavesEnd: () => void
  forwardedGesture: (gesture: ReaderGesture) => void
}
