import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, LoaderCircle } from 'lucide-react'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { StreamingMarkdownFadeRoot } from '@/components/sidebar/streaming-markdown-fade'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent } from '@/lib/agent-status'
import { translate } from '@/i18n/i18n'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import {
  buildNativeChatConversationItems,
  type NativeChatConversationItem
} from './native-chat-message-grouping'
import { stripNoiseMessages } from './native-chat-noise'
import { isNearBottom, shouldShowJumpToLatest, type ScrollGeometry } from './native-chat-autoscroll'
import { NATIVE_CHAT_STREAMING_ID } from '../../../../shared/native-chat-streaming'
import { RoomActivityDetails } from '../rooms/RoomActivityTimeline'
import { NativeChatMessageRow } from './NativeChatMessageRow'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { AgentSubagentTurnLink } from '../agent-subagents/AgentSubagentContext'
import type { NativeChatImageLoadContext } from './NativeChatImageAttachments'
import { NativeChatActivityHeader } from './NativeChatActivityHeader'

export { ProviderFrameRow } from './NativeChatTranscriptChrome'

function geometryOf(el: HTMLElement): ScrollGeometry {
  return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
}

function TypingIndicatorRow(): React.JSX.Element {
  return (
    <div
      className="flex items-center justify-start"
      aria-label={translate('components.native-chat.status.responding', 'Agent is responding')}
      aria-live="polite"
    >
      <div className="flex h-8 items-center gap-1.5 text-xs text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" />
        <span>{translate('components.native-chat.status.thinking', 'Thinking')}</span>
      </div>
    </div>
  )
}

function AssistantTurnRow({
  item,
  agent,
  assistantLabel,
  expandSignal,
  onScrollMessageToTop,
  onLinkClick,
  allowFileUriLinks,
  subagentSourceKey,
  imageLoadContext,
  runtimeContext
}: {
  item: Extract<NativeChatConversationItem, { kind: 'assistant-turn' }>
  agent: NativeChatLiveSession['agent']
  assistantLabel?: string
  expandSignal: boolean
  onScrollMessageToTop: (el: HTMLElement) => void
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks: boolean
  subagentSourceKey?: string
  imageLoadContext?: NativeChatImageLoadContext
  runtimeContext?: RuntimeFileOperationArgs | null
}): React.JSX.Element {
  const iconAgent = agentTypeToIconAgent(agent)
  const completion =
    item.startedAt != null && item.completedAt != null
      ? { startedAt: item.startedAt, completedAt: item.completedAt }
      : null
  const [activityExpanded, setActivityExpanded] = useState(item.working)
  const latestSteerId = item.segments.findLast((segment) => segment.kind === 'message')?.id
  const [previousActivity, setPreviousActivity] = useState({
    working: item.working,
    latestSteerId
  })
  if (
    previousActivity.working !== item.working ||
    previousActivity.latestSteerId !== latestSteerId
  ) {
    setPreviousActivity({ working: item.working, latestSteerId })
    if (previousActivity.working && !item.working) {
      setActivityExpanded(false)
    } else if (item.working && latestSteerId !== previousActivity.latestSteerId) {
      setActivityExpanded(true)
    }
  }

  return (
    <article className="flex min-w-0 items-start gap-3 py-2">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-card">
        <AgentIcon agent={iconAgent} size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-xs font-semibold text-foreground">
          {assistantLabel ?? `@${agent}`}
        </div>
        {item.working || item.outcome ? (
          <NativeChatActivityHeader
            messages={item.activityMessages}
            startedAt={item.startedAt}
            completedAt={completion?.completedAt ?? null}
            outcome={item.outcome}
            expanded={activityExpanded}
            onExpandedChange={setActivityExpanded}
          />
        ) : null}
        {item.segments.map((segment) =>
          segment.kind === 'message' ? (
            <div key={segment.id} className="my-3">
              <NativeChatMessageRow
                message={segment.message}
                expandSignal={expandSignal}
                onScrollMessageToTop={onScrollMessageToTop}
                onLinkClick={onLinkClick}
                allowFileUriLinks={allowFileUriLinks}
                imageLoadContext={imageLoadContext}
                runtimeContext={runtimeContext}
              />
            </div>
          ) : activityExpanded ? (
            <RoomActivityDetails key={segment.id} messages={segment.messages} />
          ) : null
        )}
        {item.working ? <TypingIndicatorRow /> : null}
        {subagentSourceKey ? (
          <AgentSubagentTurnLink
            sourceKey={subagentSourceKey}
            startedAt={item.startedAt}
            completedAt={item.completedAt}
          />
        ) : null}
        {item.finalMessage ? (
          <NativeChatMessageRow
            message={item.finalMessage}
            expandSignal={expandSignal}
            onScrollMessageToTop={onScrollMessageToTop}
            onLinkClick={onLinkClick}
            allowFileUriLinks={allowFileUriLinks}
            imageLoadContext={imageLoadContext}
            runtimeContext={runtimeContext}
            streamingFade={{ id: `native-chat:${item.id}`, start: item.working }}
          />
        ) : null}
      </div>
    </article>
  )
}

export function NativeChatMessageList({
  session,
  isWorking,
  expandSignal,
  fontScale,
  workingStartedAt = null,
  activeTurnId = null,
  onLinkClick,
  allowFileUriLinks = false,
  failedDeliveryMessageIds,
  subagentSourceKey,
  runtimeContext,
  assistantLabel,
  imageLoadContext,
  turnCompletions
}: {
  session: NativeChatLiveSession
  isWorking: boolean
  /** Toolbar-driven desired open state for every tool run; each flip re-syncs. */
  expandSignal: boolean
  /** Chat-only text multiplier (1 = default), driven by the zoom shortcuts. */
  fontScale: number
  /** Authoritative hook epoch for the current turn, when available. */
  workingStartedAt?: number | null
  activeTurnId?: string | null
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
  failedDeliveryMessageIds?: ReadonlySet<string>
  subagentSourceKey?: string
  runtimeContext?: RuntimeFileOperationArgs | null
  assistantLabel?: string
  imageLoadContext?: NativeChatImageLoadContext
  turnCompletions?: Readonly<
    Record<string, { outcome: 'completed' | 'interrupted' | 'failed'; completedAt: number }>
  >
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

  // Strip harness noise before grouping every assistant generation into one
  // chronological activity + final-answer turn.
  const conversationItems = useMemo(
    () =>
      buildNativeChatConversationItems(
        stripNoiseMessages(session.messages),
        isWorking,
        workingStartedAt,
        activeTurnId,
        turnCompletions
      ),
    [session.messages, isWorking, workingStartedAt, activeTurnId, turnCompletions]
  )
  const showTypingIndicator =
    isWorking &&
    !session.messages.some((message) => message.id === NATIVE_CHAT_STREAMING_ID) &&
    !conversationItems.some((item) => item.kind === 'assistant-turn' && item.working)

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
  }, [conversationItems.length, isWorking, showTypingIndicator, scrollToBottom])

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
    <StreamingMarkdownFadeRoot className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="scrollbar-sleek h-full overflow-y-auto px-3 pt-10 pb-4 sm:px-4"
      >
        <div
          ref={contentRef}
          // Why: same max width as the composer column; horizontal inset comes
          // from the scroll container so content aligns with the composer field.
          className="mx-auto flex w-full max-w-4xl flex-col gap-1.5"
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
          {conversationItems.map((item) =>
            item.kind === 'assistant-turn' ? (
              <AssistantTurnRow
                key={item.id}
                item={item}
                agent={session.agent}
                assistantLabel={assistantLabel}
                expandSignal={expandSignal}
                onScrollMessageToTop={scrollMessageToTop}
                onLinkClick={onLinkClick}
                allowFileUriLinks={allowFileUriLinks}
                subagentSourceKey={subagentSourceKey}
                imageLoadContext={imageLoadContext}
                runtimeContext={runtimeContext}
              />
            ) : (
              <NativeChatMessageRow
                key={item.id}
                message={item.message}
                expandSignal={expandSignal}
                onScrollMessageToTop={scrollMessageToTop}
                onLinkClick={onLinkClick}
                allowFileUriLinks={allowFileUriLinks}
                deliveryFailed={failedDeliveryMessageIds?.has(item.message.id) === true}
                imageLoadContext={imageLoadContext}
                runtimeContext={runtimeContext}
              />
            )
          )}
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
    </StreamingMarkdownFadeRoot>
  )
}
