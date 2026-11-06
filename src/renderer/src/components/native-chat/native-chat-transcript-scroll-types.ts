import type { RefObject, UIEventHandler } from 'react'
import type { ReaderGesture } from './native-chat-autoscroll'
import type { NativeChatAlignEdge } from './use-native-chat-viewport-align'

export type NativeChatTranscriptScrollOptions = {
  scrollRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  itemCount: number
  isWorking: boolean
  /** Whether the list draws a row after the transcript (live activity or a wait). */
  showsTailRow: boolean
  isVisible: boolean
  alignToViewportTop: (element: HTMLElement, edge?: NativeChatAlignEdge) => void
  isAlignPending: () => boolean
  scrollToEnd: () => void
  restoreScrollOffset: (offset: number) => void
  consumeProgrammaticScroll: (event: Event) => boolean
  reconcileReaderScroll: (isTakingOver: boolean) => void
  onLeaveEnd?: () => void
  onReturnToEnd?: (reason?: 'send') => void
}

export type NativeChatTranscriptScroll = {
  showJump: boolean
  recordReaderScroll: () => void
  onScroll: UIEventHandler<HTMLDivElement>
  scrollToBottom: (reason?: 'send') => void
  /** Following, or close enough to the end that Jump to latest stays hidden. */
  readerAtEnd: () => boolean
  scrollMessageToTop: (element: HTMLElement, edge?: NativeChatAlignEdge) => void
  /** A reader gesture left the end: the only thing besides a row jump that stops following. */
  readerLeavesEnd: () => void
  forwardedGesture: (gesture: ReaderGesture) => void
}
