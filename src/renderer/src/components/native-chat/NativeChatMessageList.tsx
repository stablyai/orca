import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Image as ImageIcon } from 'lucide-react'
import CommentMarkdown, {
  type CommentMarkdownLinkClickHandler
} from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import {
  isTextBlock,
  type NativeChatBlock,
  type NativeChatMessage
} from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { orderNativeChatMessages } from './native-chat-message-grouping'
import { stripNoiseMessages } from './native-chat-noise'
import { foldToolMessages, splitNativeChatBlocks } from './native-chat-tool-fold'
import { isNearBottom, shouldShowJumpToLatest, type ScrollGeometry } from './native-chat-autoscroll'
import { isNativeChatPastedImagePath } from './native-chat-image-paste'
import { NativeChatToolRun } from './NativeChatToolRun'
import { NativeChatCopyButton } from './NativeChatCopyButton'
import { NATIVE_CHAT_STREAMING_ID } from '../../../../shared/native-chat-streaming'

function geometryOf(el: HTMLElement): ScrollGeometry {
  return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
}

function proseToMarkdown(blocks: NativeChatBlock[]): string {
  return blocks
    .map((block) => {
      if (isTextBlock(block)) {
        return block.text
      }
      return ''
    })
    .filter((part) => part.length > 0)
    .join('\n\n')
}

function ImageAttachmentRefs({ blocks }: { blocks: NativeChatBlock[] }): React.JSX.Element | null {
  const images = blocks.filter((block) => block.type === 'image-ref')
  if (images.length === 0) {
    return null
  }
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {images.map((image, index) => {
        const label = image.alt ?? image.path ?? image.url ?? 'Image'
        const name =
          image.path && isNativeChatPastedImagePath(image.path)
            ? translate('components.native-chat.composer.pastedImageLabel', 'Pasted image')
            : image.path
              ? basename(image.path)
              : label
        return (
          <div
            key={`${label}-${index}`}
            className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground"
            title={label}
          >
            <ImageIcon className="size-3.5 shrink-0" />
            <span className="truncate">{name}</span>
          </div>
        )
      })}
    </div>
  )
}

/** Inline controls for an agent message (mobile AgentControls parity): copy the
 *  message's prose, and scroll so this message's top aligns to the viewport top.
 *  Reveals on hover / keyboard focus like the prior copy affordance. */
function AgentControls({
  markdown,
  onScrollToTop,
  className
}: {
  markdown: string
  onScrollToTop: () => void
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <NativeChatCopyButton text={markdown} />
      <button
        type="button"
        onClick={onScrollToTop}
        aria-label={translate(
          'components.native-chat.scrollMessageToTop',
          'Scroll this message to top'
        )}
        title={translate('components.native-chat.scrollMessageToTop', 'Scroll this message to top')}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowUp className="size-3.5" />
      </button>
    </div>
  )
}

function TypingIndicatorRow(): React.JSX.Element {
  return (
    <div
      className="flex items-center justify-start"
      aria-label={translate('components.native-chat.status.responding', 'Agent is responding')}
      aria-live="polite"
    >
      <div className="flex h-8 items-center gap-1.5 text-muted-foreground">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 animate-bounce rounded-full bg-muted-foreground/70"
            // Stagger the three dots so they ripple rather than pulse in unison.
            style={{ animationDelay: `${i * 160}ms` }}
          />
        ))}
      </div>
    </div>
  )
}

/** One message: its prose first, then a collapsible run folding all of the
 *  turn's tool activity. Monochrome per STYLEGUIDE: user prompts read as a
 *  lifted card, assistant prose as body copy, reasoning de-emphasized. */
function MessageRow({
  message,
  expandSignal,
  onScrollMessageToTop,
  onLinkClick,
  allowFileUriLinks = false,
  deliveryFailed = false
}: {
  message: NativeChatMessage
  expandSignal: boolean
  /** Align this message's top to the top of the scroll viewport. */
  onScrollMessageToTop: (el: HTMLElement) => void
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
  deliveryFailed?: boolean
}): React.JSX.Element | null {
  const rowRef = useRef<HTMLDivElement | null>(null)
  const { prose, tools } = useMemo(() => splitNativeChatBlocks(message.blocks), [message.blocks])
  const markdown = proseToMarkdown(prose)
  const hasImages = prose.some((block) => block.type === 'image-ref')
  const isUser = message.role === 'user'
  const isReasoning = message.role === 'reasoning'
  const isSystem = message.role === 'system'

  const scrollToTop = useCallback(() => {
    if (rowRef.current) {
      onScrollMessageToTop(rowRef.current)
    }
  }, [onScrollMessageToTop])

  // Skip rows with nothing renderable so the transcript shows no empty/ghost
  // bubble.
  // After all hooks, so hook order stays unconditional.
  if (markdown.length === 0 && !hasImages && tools.length === 0) {
    return null
  }

  if (isUser) {
    // Why: an optimistic echo is rendered identically to a real user turn (no
    // muting, no "Queued" label) so that when the real transcript turn lands and
    // replaces it, there is no visible state change — the send just appears and
    // stays. (A distinct "queued" treatment flickered normal→queued→normal as the
    // transcript caught up.)
    return (
      <div ref={rowRef} className="flex flex-col items-end gap-0.5">
        {/* User turns get a distinct muted fill (not the card/canvas color) so
            the prompt reads apart from the assistant's body copy. */}
        <div className="max-w-[85%] rounded-lg rounded-tr-sm bg-muted px-3.5 py-2.5 text-sm text-foreground">
          {markdown ? (
            <>
              <ImageAttachmentRefs blocks={prose} />
              <CommentMarkdown
                content={markdown}
                variant="document"
                className="text-sm"
                onLinkClick={onLinkClick}
                allowFileUriLinks={allowFileUriLinks}
              />
            </>
          ) : (
            <ImageAttachmentRefs blocks={prose} />
          )}
        </div>
        {deliveryFailed ? (
          <div className="max-w-[85%] text-[11px] text-destructive/80">
            {translate(
              'components.native-chat.launchPromptNotDelivered',
              'Not delivered — check the terminal'
            )}
          </div>
        ) : null}
      </div>
    )
  }

  // Plain assistant prose is the copyable unit; reasoning/system asides stay
  // chrome-free. The controls reveal on hover (and on keyboard focus-within).
  const showControls = !isReasoning && !isSystem && markdown.length > 0

  return (
    <div
      ref={rowRef}
      className={cn(
        'group relative max-w-full text-sm leading-relaxed text-foreground',
        // Reasoning is the agent thinking aloud — quieter, italic, like an aside.
        isReasoning && 'border-l-2 border-border/60 pl-3 italic text-muted-foreground',
        isSystem && 'text-xs text-muted-foreground'
      )}
    >
      {showControls ? (
        <AgentControls
          markdown={markdown}
          onScrollToTop={scrollToTop}
          className="absolute -top-8 right-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        />
      ) : null}
      <ImageAttachmentRefs blocks={prose} />
      {markdown ? (
        <CommentMarkdown
          content={markdown}
          variant="document"
          className="text-sm"
          onLinkClick={onLinkClick}
          allowFileUriLinks={allowFileUriLinks}
        />
      ) : null}
      {tools.length > 0 ? <NativeChatToolRun blocks={tools} expandSignal={expandSignal} /> : null}
    </div>
  )
}

export function NativeChatMessageList({
  session,
  isWorking,
  expandSignal,
  fontScale,
  onLinkClick,
  allowFileUriLinks = false,
  failedDeliveryMessageIds
}: {
  session: NativeChatLiveSession
  isWorking: boolean
  /** Toolbar-driven desired open state for every tool run; each flip re-syncs. */
  expandSignal: boolean
  /** Chat-only text multiplier (1 = default), driven by the zoom shortcuts. */
  fontScale: number
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
  failedDeliveryMessageIds?: ReadonlySet<string>
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [stuckToBottom, setStuckToBottom] = useState(true)
  const [showJump, setShowJump] = useState(false)

  // Why: mirror stuck state into a ref so the auto-scroll layout effect can read
  // it without depending on it — depending on stuckToBottom (which scrollToBottom
  // sets) would re-fire the effect in a self-loop.
  const stuckToBottomRef = useRef(stuckToBottom)
  stuckToBottomRef.current = stuckToBottom

  const { hasMore, loadingEarlier, loadEarlier } = session

  // Strip harness noise (task-notifications, system reminders, slash-command
  // envelopes) before folding so they don't render as the user's own bubbles —
  // matching the mobile chat. Then fold each turn's tool activity into the
  // assistant message it belongs to, ordered stably, so a turn's tools collapse
  // under one run.
  const messages = useMemo(
    () => foldToolMessages(orderNativeChatMessages(stripNoiseMessages(session.messages))),
    [session.messages]
  )
  const showTypingIndicator =
    isWorking && !messages.some((message) => message.id === NATIVE_CHAT_STREAMING_ID)

  // When an older page prepends, the scroll content grows above the viewport.
  // Capture the pre-render scroll height so the layout effect can restore the
  // user's position (no jump) instead of letting the browser keep scrollTop.
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    const geometry = geometryOf(el)
    const stick = isNearBottom(geometry)
    setStuckToBottom(stick)
    setShowJump(shouldShowJumpToLatest(stick, geometry))
    // Near the top — page in older history, anchoring the current position so the
    // prepend doesn't yank the view.
    if (geometry.scrollTop < 80 && hasMore && !loadingEarlier) {
      prependAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
      loadEarlier()
    }
  }, [hasMore, loadingEarlier, loadEarlier])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    el.scrollTop = el.scrollHeight
    setStuckToBottom(true)
    setShowJump(false)
  }, [])

  // Align a single message's top to the top of the scroll viewport.
  const scrollMessageToTop = useCallback((el: HTMLElement) => {
    const container = scrollRef.current
    if (!container) {
      return
    }
    // Detach synchronously (not just via the pending onScroll) so an in-place
    // streaming growth can't re-pin to the bottom mid-flight and fight this
    // deliberate scroll. The ref is what the resize observer reads.
    stuckToBottomRef.current = false
    setStuckToBottom(false)
    const delta = el.getBoundingClientRect().top - container.getBoundingClientRect().top
    container.scrollTo({ top: container.scrollTop + delta, behavior: 'smooth' })
  }, [])

  // Re-pin to the bottom when new content arrives, but only if the user hasn't
  // scrolled up. Layout effect so the jump happens before paint (no flicker).
  // When an older page just prepended, restore the prior position instead.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && prependAnchorRef.current) {
      // Preserve the viewport: shift scrollTop by however much taller the content
      // got, so the message the user was reading stays put.
      const grew = el.scrollHeight - prependAnchorRef.current.scrollHeight
      el.scrollTop = prependAnchorRef.current.scrollTop + grew
      prependAnchorRef.current = null
      return
    }
    if (stuckToBottomRef.current) {
      scrollToBottom()
    }
  }, [messages.length, isWorking, showTypingIndicator, scrollToBottom])

  // Content growing without a message-count change (a streaming assistant turn
  // extends its own message in place) never re-fires the layout effect above.
  // Observe the container so those in-place growths still re-pin: stay glued to
  // the bottom while stuck, otherwise just refresh the jump affordance. This is
  // what removes most "Jump to latest" clicks during a live response.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      if (stuckToBottomRef.current) {
        scrollToBottom()
      } else {
        handleScroll()
      }
    })
    // Observe the growing content, not just the fixed-height viewport, so an
    // in-place streaming growth is seen; also watch the viewport for reflows.
    observer.observe(el)
    if (contentRef.current) {
      observer.observe(contentRef.current)
    }
    return () => observer.disconnect()
  }, [handleScroll, scrollToBottom])

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="scrollbar-sleek h-full overflow-y-auto px-3 pt-10 pb-4 sm:px-4"
      >
        <div
          ref={contentRef}
          className="mx-auto flex w-full max-w-4xl flex-col gap-5"
          // Why: `zoom` scales the chat transcript's text and layout together,
          // scoped to this container so the rest of the app is untouched. It's
          // the desktop analog of the mobile pinch-zoom (Chromium/Electron only).
          style={{ zoom: fontScale }}
        >
          {hasMore ? (
            <div className="flex justify-center py-1">
              <button
                type="button"
                onClick={loadEarlier}
                disabled={loadingEarlier}
                className="rounded-md px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              >
                {loadingEarlier
                  ? translate('components.native-chat.loadingEarlier', 'Loading…')
                  : translate('components.native-chat.loadEarlier', 'Load earlier messages')}
              </button>
            </div>
          ) : null}
          {messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              expandSignal={expandSignal}
              onScrollMessageToTop={scrollMessageToTop}
              onLinkClick={onLinkClick}
              allowFileUriLinks={allowFileUriLinks}
              deliveryFailed={failedDeliveryMessageIds?.has(message.id) === true}
            />
          ))}
          {showTypingIndicator ? <TypingIndicatorRow /> : null}
        </div>
      </div>
      {showJump ? (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label={translate('components.native-chat.jumpToLatest', 'Jump to latest')}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card/90 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowDown className="size-3.5" />
          <span>{translate('components.native-chat.jumpToLatest', 'Jump to latest')}</span>
        </button>
      ) : null}
    </div>
  )
}
