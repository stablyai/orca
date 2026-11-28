import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { copyChatMathSelection } from '../comment-markdown/chat-markdown-math-selection'
import { NativeChatJumpToLatest } from './viewport/scroll/NativeChatJumpToLatest'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from './messages/disclosure/native-chat-disclosure-store'
import type { ReaderGesture } from './viewport/scroll/native-chat-autoscroll'
import { NativeChatForwardedGestureContext } from './viewport/scroll/native-chat-reader-scroll-input'
import {
  NativeChatTranscriptScrollContext,
  type NativeChatToolRunScroll
} from './viewport/scroll/native-chat-transcript-scroll-context'

/** Every transcript's scroller: disclosures, forwarded visual gestures, math copy, and Jump to latest. */
export function NativeChatTranscriptViewport({
  scrollRef,
  scrollerProps,
  toolRunScroll,
  forwardedGesture,
  showJump,
  onJump,
  overlays,
  label,
  children
}: {
  scrollRef: Ref<HTMLDivElement>
  scrollerProps: HTMLAttributes<HTMLDivElement>
  toolRunScroll: NativeChatToolRunScroll
  /** A reader gesture a row's visual frame took before the transcript could see it. */
  forwardedGesture: (gesture: ReaderGesture) => void
  showJump: boolean
  onJump: () => void
  /** Drawn over the scroller, beside Jump to latest. */
  overlays?: ReactNode
  /** The scroller's accessible name; the conversation by default. */
  label?: string
  children: ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const disclosures = useNativeChatDisclosures()
  return (
    <NativeChatDisclosureContext.Provider value={disclosures}>
      <NativeChatForwardedGestureContext.Provider value={forwardedGesture}>
        {/* Never shorter than the worker chip that sits on its end (0 without one). */}
        <div className="relative min-h-[var(--native-chat-worker-chip-room,0px)] flex-1">
          <div
            ref={scrollRef}
            {...scrollerProps}
            onCopy={copyChatMathSelection}
            // Measurement finds this named scroll root independently of utility classes.
            data-native-chat-scroll
            aria-label={label ?? t('components.native-chat.transcriptLabel', 'Conversation')}
            // Browser anchoring would add unattributed movement beside the follow policy's anchor.
            className="scrollbar-sleek relative h-full overflow-y-auto [overflow-anchor:none] [scrollbar-gutter:stable_both-edges] focus-visible:outline-none"
          >
            <NativeChatTranscriptScrollContext.Provider value={toolRunScroll}>
              {children}
            </NativeChatTranscriptScrollContext.Provider>
          </div>
          {overlays}
          <NativeChatJumpToLatest visible={showJump} onJump={onJump} />
        </div>
      </NativeChatForwardedGestureContext.Provider>
    </NativeChatDisclosureContext.Provider>
  )
}
