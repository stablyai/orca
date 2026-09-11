import { useCallback, useMemo, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { translate } from '@/i18n/i18n'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { createNativeChatMessageListProjection } from './native-chat-message-list-projection'
import { nativeChatTaskListState } from './native-chat-task-list-state'
import { nativeChatTaskListPredecessors } from './native-chat-task-list-history'
import { NativeChatTaskList } from './NativeChatTaskList'
import { projectNativeChatTaskListFrames } from './native-chat-task-list-frames'
import { shouldShowNativeChatTypingIndicator } from './native-chat-typing-indicator'
import { NativeChatWorkingStatus } from './NativeChatWorkingStatus'
import { useNativeChatTurnStatus } from './use-native-chat-turn-status'
import { NativeChatTypingIndicatorRow } from './NativeChatTypingIndicatorRow'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import type { NativeChatTurnActivity } from './native-chat-turn-activity'
import { NativeChatTurnActivityLine } from './NativeChatTurnActivityLine'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from './native-chat-disclosure-store'
import { NativeChatTranscriptItems } from './NativeChatTranscriptItems'
import type { NativeChatTranscriptRowContext } from './NativeChatTranscriptRow'
import {
  buildNativeChatTranscriptSlots,
  nativeChatSlotIndexOf
} from './native-chat-transcript-slots'
import { useNativeChatTranscriptWindow } from './use-native-chat-transcript-window'
import { useNativeChatTranscriptScroll } from './use-native-chat-transcript-scroll'

import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { NativeChatSettledTurns } from '../../../../shared/native-chat-turn-status'
import {
  nativeChatTurnDiffs,
  type NativeChatDiffReveal,
  type NativeChatDiffTarget,
  type NativeChatTurnDiff
} from './native-chat-turn-diffs'

export { ProviderFrameRow } from './NativeChatTranscriptChrome'

const MAX_EXPANDED_TURNS = 128

export function NativeChatMessageList({
  session,
  journalItems,
  isWorking,
  expandSignal,
  fontScale,
  onLinkClick,
  allowFileUriLinks = false,
  workingStartedAt,
  settledTurns,
  failedDeliveryMessageIds,
  showTurnStatus = true,
  turnActivity,
  runtimeContext
}: {
  session: NativeChatLiveSession
  journalItems?: readonly AgentJournalRenderItem[]
  isWorking: boolean
  /** Toolbar-driven desired open state for every tool run; each flip re-syncs. */
  expandSignal: boolean
  /** Chat-only text multiplier (1 = default), driven by the zoom shortcuts. */
  fontScale: number
  workingStartedAt?: number | null
  /** Host-recorded turn durations keyed by user message id (structured lane). */
  settledTurns?: NativeChatSettledTurns
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
  failedDeliveryMessageIds?: ReadonlySet<string>
  /** Turn timing and disclosure are available on structured agent sessions. */
  showTurnStatus?: boolean
  turnActivity?: NativeChatTurnActivity | null
  runtimeContext?: RuntimeFileOperationArgs | null
}): React.JSX.Element {
  const [revealedDiff, setRevealedDiff] = useState<NativeChatDiffReveal | null>(null)
  const revealDiff = useCallback((target: NativeChatDiffTarget) => {
    setRevealedDiff((current) => ({ ...target, requestId: (current?.requestId ?? 0) + 1 }))
  }, [])
  const receipts = useMemo(
    () =>
      new Map(
        journalItems?.flatMap((item) =>
          (item.body.kind === 'approval' || item.body.kind === 'question') &&
          item.body.resolution.state !== 'pending'
            ? [[item.itemId, item.body] as const]
            : []
        )
      ),
    [journalItems]
  )
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<string>>(new Set())
  const disclosures = useNativeChatDisclosures()
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

  const { hasMore, loadingEarlier, loadEarlier } = session

  const projectMessages = useMemo(
    () => createNativeChatMessageListProjection(),
    // Rebound sessions must release the previous transcript's cached rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.agent, session.sessionId]
  )
  const messages = useMemo(
    () => projectNativeChatTaskListFrames(projectMessages(session.messages)),
    [projectMessages, session.messages]
  )
  const taskListPredecessors = useMemo(() => nativeChatTaskListPredecessors(messages), [messages])
  const taskListState = useMemo(() => nativeChatTaskListState(messages), [messages])
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
  const turnDiffs = useMemo(
    () =>
      journalItems
        ? nativeChatTurnDiffs(messages, turnKeys)
        : new Map<string, NativeChatTurnDiff>(),
    [journalItems, messages, turnKeys]
  )
  const turnStatuses = useNativeChatTurnStatus({
    messages,
    latestUserIndex,
    isWorking: showTurnStatus && isWorking,
    workingStartedAt: showTurnStatus ? workingStartedAt : null,
    settledTurns: showTurnStatus ? settledTurns : null
  })
  const lifecycleWorking = session.transcriptLifecycle?.state === 'working'
  const slots = useMemo(
    () =>
      buildNativeChatTranscriptSlots({
        messages,
        turnKeys,
        latestUserIndex,
        currentTurnKey,
        receipts,
        turnStatuses,
        turnDiffs,
        showTurnStatus,
        showTypingIndicator,
        isWorking,
        lifecycleWorking
      }),
    [
      currentTurnKey,
      isWorking,
      latestUserIndex,
      lifecycleWorking,
      messages,
      receipts,
      showTurnStatus,
      showTypingIndicator,
      turnDiffs,
      turnKeys,
      turnStatuses
    ]
  )
  const transcriptWindow = useNativeChatTranscriptWindow({
    scrollRef,
    slots,
    revealIndex: nativeChatSlotIndexOf(slots, revealedDiff?.messageId)
  })
  const { showJump, onScroll, scrollToBottom, scrollMessageToTop } = useNativeChatTranscriptScroll({
    scrollRef,
    contentRef,
    itemCount: slots.length,
    isWorking,
    showTypingIndicator,
    hasMore,
    loadingEarlier,
    loadEarlier,
    alignToViewportTop: transcriptWindow.alignToViewportTop
  })

  const rowContext = useMemo<NativeChatTranscriptRowContext>(
    () => ({
      expandSignal,
      showTurnStatus,
      revealedDiff,
      taskListPredecessors,
      expandedTurnIds,
      failedDeliveryMessageIds,
      allowFileUriLinks,
      runtimeContext,
      onLinkClick,
      onToggleExpandedTurn: toggleExpandedTurn,
      onScrollMessageToTop: scrollMessageToTop,
      onRevealDiff: revealDiff
    }),
    [
      allowFileUriLinks,
      expandSignal,
      expandedTurnIds,
      failedDeliveryMessageIds,
      onLinkClick,
      revealDiff,
      revealedDiff,
      runtimeContext,
      scrollMessageToTop,
      showTurnStatus,
      taskListPredecessors,
      toggleExpandedTurn
    ]
  )

  return (
    <NativeChatDisclosureContext.Provider value={disclosures}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            onScroll={onScroll}
            // Named so measurement can find the scroll root without depending on
            // which utility class happens to make it scroll.
            data-native-chat-scroll
            className="scrollbar-sleek relative h-full overflow-y-auto [scrollbar-gutter:stable_both-edges]"
            // Why: `zoom` scales the chat transcript's text and layout together,
            // scoped to this pane so the rest of the app is untouched. It sits on
            // the scroll container rather than the content inside it so that
            // scroll offsets and row measurements share one coordinate space —
            // measuring zoomed content against an unzoomed scroller misplaces the
            // window by exactly `fontScale`. (Chromium/Electron only.)
            style={{ zoom: fontScale }}
          >
            <div className="px-3 pt-10 pb-4 sm:px-4">
              <div
                ref={contentRef}
                // Why: matches composer column (max-w-4xl) with 5px horizontal inset
                // on each side so content is slightly narrower than the input box.
                className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-[5px]"
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
                <NativeChatTranscriptItems
                  slots={slots}
                  context={rowContext}
                  window={transcriptWindow}
                />
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
                {showTurnStatus && isWorking ? (
                  <NativeChatTurnActivityLine activity={turnActivity} />
                ) : null}
                {!showTurnStatus && showTypingIndicator ? <NativeChatTypingIndicatorRow /> : null}
              </div>
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
        {taskListState.list && taskListState.list.tasks.length > 0 ? (
          <div className="shrink-0 px-3 pb-2 sm:px-4">
            <div className="mx-auto w-full max-w-4xl" style={{ zoom: fontScale }}>
              <NativeChatTaskList
                key={session.sessionId}
                list={taskListState.list}
                presentation="composer"
              />
            </div>
          </div>
        ) : null}
      </div>
    </NativeChatDisclosureContext.Provider>
  )
}
