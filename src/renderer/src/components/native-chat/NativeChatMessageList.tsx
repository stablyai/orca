import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { translate } from '@/i18n/i18n'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { orderNativeChatMessages } from './native-chat-message-grouping'
import { stripNoiseMessages } from './native-chat-noise'
import { foldToolMessages } from './native-chat-tool-fold'
import { isNearBottom, shouldShowJumpToLatest, type ScrollGeometry } from './native-chat-autoscroll'
import { MessageRow } from './NativeChatMessageRow'
import { shouldShowNativeChatTypingIndicator } from './native-chat-typing-indicator'
import { NativeChatWorkingStatus } from './NativeChatWorkingStatus'
import { useNativeChatTurnStatus } from './use-native-chat-turn-status'
import { NativeChatTypingIndicatorRow } from './NativeChatTypingIndicatorRow'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'

export { ProviderFrameRow } from './NativeChatTranscriptChrome'

function geometryOf(el: HTMLElement): ScrollGeometry {
  return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
}

const MAX_EXPANDED_TURNS = 128

export function NativeChatMessageList({
  session,
  isWorking,
  expandSignal,
  fontScale,
  onLinkClick,
  allowFileUriLinks = false,
  workingStartedAt,
  failedDeliveryMessageIds,
  showTurnStatus = true,
  runtimeContext
}: {
  session: NativeChatLiveSession
  isWorking: boolean
  /** Toolbar-driven desired open state for every tool run; each flip re-syncs. */
  expandSignal: boolean
  /** Chat-only text multiplier (1 = default), driven by the zoom shortcuts. */
  fontScale: number
  workingStartedAt?: number | null
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
  failedDeliveryMessageIds?: ReadonlySet<string>
  /** Turn timing and disclosure are available on structured agent sessions. */
  showTurnStatus?: boolean
  runtimeContext?: RuntimeFileOperationArgs | null
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [stuckToBottom, setStuckToBottom] = useState(true)
  const [showJump, setShowJump] = useState(false)
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<string>>(new Set())
  const toggleExpandedTurn = useCallback((turnKey: string) => {
    setExpandedTurnIds((current) => {
      const next = new Set(current)
      if (next.has(turnKey)) {
        next.delete(turnKey)
      } else {
        if (next.size >= MAX_EXPANDED_TURNS) {
          const oldest = next.values().next().value
          if (oldest) {
            next.delete(oldest)
          }
        }
        next.add(turnKey)
      }
      return next
    })
  }, [])

  const stuckToBottomRef = useRef(stuckToBottom)
  stuckToBottomRef.current = stuckToBottom
  const { hasMore, loadingEarlier, loadEarlier } = session

  // Keep hidden harness turns as fold boundaries, then strip them before render.
  const messages = useMemo(
    () => stripNoiseMessages(foldToolMessages(orderNativeChatMessages(session.messages))),
    [session.messages]
  )
  const showTypingIndicator = showTurnStatus
    ? isWorking
    : shouldShowNativeChatTypingIndicator({ messages, isWorking })
  const latestUserIndex = messages.findLastIndex((message) => message.role === 'user')
  const currentTurnKey =
    latestUserIndex === -1 ? undefined : (messages[latestUserIndex]?.id ?? undefined)
  // Resolve each row's turn boundary once. Prefix slice/findLast in the render
  // loop becomes quadratic for long transcripts.
  const turnKeys = useMemo(() => {
    let currentTurnKey: string | undefined
    return messages.map((message) => {
      if (message.role === 'user') {
        currentTurnKey = message.id
      }
      return currentTurnKey
    })
  }, [messages])
  const turnStatuses = useNativeChatTurnStatus({
    messages,
    latestUserIndex,
    isWorking: showTurnStatus && isWorking,
    workingStartedAt: showTurnStatus ? workingStartedAt : null
  })

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
    stuckToBottomRef.current = false
    setStuckToBottom(false)
    const delta = el.getBoundingClientRect().top - container.getBoundingClientRect().top
    container.scrollTo({ top: container.scrollTop + delta, behavior: 'smooth' })
  }, [])

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
          // Why: same max width as the composer column; horizontal inset comes
          // from the scroll container so content aligns with the composer field.
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
          {messages.map((message, index) => {
            const turnKey = turnKeys[index]
            const isCurrentTurn = currentTurnKey
              ? turnKey === currentTurnKey
              : turnKey === undefined
            const status =
              index === latestUserIndex
                ? turnStatuses.active
                : message.role === 'user' && turnKey
                  ? turnStatuses.completedByTurn[turnKey]
                  : undefined
            return (
              <Fragment key={message.id}>
                <MessageRow
                  message={message}
                  expandSignal={expandSignal}
                  // A missing transcript lifecycle is not evidence that the turn
                  // ended. Structured sessions and legacy live hooks still expose
                  // the authoritative session-level working state.
                  activeTurnIsWorking={
                    showTurnStatus &&
                    isCurrentTurn &&
                    (isWorking || session.transcriptLifecycle?.state === 'working')
                  }
                  onScrollMessageToTop={scrollMessageToTop}
                  onLinkClick={onLinkClick}
                  allowFileUriLinks={allowFileUriLinks}
                  deliveryFailed={failedDeliveryMessageIds?.has(message.id) === true}
                  structuredActivityUi={showTurnStatus}
                  activityExpandOverride={turnKey ? expandedTurnIds.has(turnKey) : undefined}
                  runtimeContext={runtimeContext}
                />
                {showTurnStatus &&
                status &&
                (index !== latestUserIndex || showTypingIndicator || !isWorking) ? (
                  <NativeChatWorkingStatus
                    startedAt={status.startedAt}
                    thinking={status.thinking}
                    workedSeconds={status.workedSeconds}
                    expanded={turnKey ? expandedTurnIds.has(turnKey) : false}
                    onToggleExpanded={
                      status.workedSeconds != null && turnKey
                        ? () => toggleExpandedTurn(turnKey)
                        : undefined
                    }
                  />
                ) : null}
              </Fragment>
            )
          })}
          {showTurnStatus &&
          latestUserIndex === -1 &&
          turnStatuses.active &&
          showTypingIndicator ? (
            <NativeChatWorkingStatus
              startedAt={turnStatuses.active.startedAt}
              thinking={turnStatuses.active.thinking}
              workedSeconds={turnStatuses.active.workedSeconds}
            />
          ) : null}
          {!showTurnStatus && showTypingIndicator ? <NativeChatTypingIndicatorRow /> : null}
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
