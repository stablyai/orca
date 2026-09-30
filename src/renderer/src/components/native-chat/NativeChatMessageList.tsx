import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { translate } from '@/i18n/i18n'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { createNativeChatMessageListProjection } from './native-chat-message-list-projection'
import { structuredQuestionTranscript } from './structured-agent-question-projection'
import { nativeChatTaskListState } from './native-chat-task-list-state'
import { nativeChatTaskListPredecessors } from './native-chat-task-list-history'
import { NativeChatTaskList } from './NativeChatTaskList'
import { projectNativeChatTaskListFrames } from './native-chat-task-list-frames'
import { omitNativeChatThreadGoalRows } from './native-chat-thread-goal-rows'
import { useNativeChatTurnStatus } from './use-native-chat-turn-status'
import { NativeChatAwaitingInputRow } from './NativeChatAwaitingInputRow'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import type { NativeChatTurnActivity } from '../../../../shared/native-chat-turn-activity'
import { NativeChatTurnActivityLine } from './NativeChatTurnActivityLine'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from './native-chat-disclosure-store'
import {
  NativeChatTranscriptItems,
  NativeChatWaitingTranscriptItems
} from './NativeChatTranscriptItems'
import type { NativeChatTranscriptRowContext } from './NativeChatTranscriptRow'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'
import {
  buildNativeChatTranscriptSlots,
  splitNativeChatSlotsWaitingBehindLiveTurn,
  nativeChatSlotIndexOf
} from './native-chat-transcript-slots'
import { useNativeChatTranscriptWindow } from './use-native-chat-transcript-window'
import { useNativeChatTurnMembership } from './use-native-chat-turn-membership'
import { useNativeChatTranscriptScroll } from './use-native-chat-transcript-scroll'
import { useNativeChatOlderHistoryAutoload } from './use-native-chat-older-history-autoload'
import { NativeChatOlderHistoryRow } from './NativeChatOlderHistoryRow'
import { useNativeChatMessageRail } from './use-native-chat-message-rail'
import { NativeChatMessageRail } from './NativeChatMessageRail'
import type {
  NativeChatRailItem,
  NativeChatRailOutlineEntry
} from './native-chat-message-rail-items'
import { useNativeChatRailHistoryJump } from './use-native-chat-rail-history-jump'
import { nativeChatReaderScrollInputHandlers } from './native-chat-reader-scroll-input'

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { isStructuredAgentSessionThinking } from '../../../../shared/structured-agent-session-live-turn'
import { nativeChatSubagentLabels } from '../../../../shared/native-chat-subagent-attribution'
import type { NativeChatSettledTurns } from '../../../../shared/native-chat-turn-status'
import {
  nativeChatTurnDiffs,
  type NativeChatDiffReveal,
  type NativeChatDiffTarget,
  type NativeChatTurnDiff
} from './native-chat-turn-diffs'

export { ProviderFrameRow } from './NativeChatTranscriptChrome'

const MAX_EXPANDED_TURNS = 128

/** The turn is blocked on the reader. `shown`: the pane draws the prompt itself, as a card;
 *  `unshown`: it cannot (the prompt is only in the agent's terminal). */
export type NativeChatAwaitingInput = 'shown' | 'unshown'

type NativeChatNavigationRequest =
  | { kind: 'diff'; target: NativeChatDiffReveal }
  | { kind: 'rail'; messageId: string; requestId: number }

export function NativeChatMessageList({
  session,
  journalItems,
  journalSubmissions,
  railOutline = null,
  isVisible = true,
  isWorking,
  expandSignal,
  fontScale,
  onLinkClick,
  allowFileUriLinks = false,
  workingStartedAt,
  settledTurns,
  deliveryNotices,
  awaitingInput = null,
  turnActivity,
  runtimeContext
}: {
  session: NativeChatLiveSession
  journalItems?: readonly AgentJournalRenderItem[]
  /** With the items, what places each row in its turn (structured lane). */
  journalSubmissions?: readonly AgentJournalSubmission[]
  /** User messages older than the loaded window, from the host's outline. */
  railOutline?: readonly NativeChatRailOutlineEntry[] | null
  isVisible?: boolean
  isWorking: boolean
  /** Toolbar-driven desired open state for every tool run; each flip re-syncs. */
  expandSignal: boolean
  /** Chat-only text multiplier (1 = default), driven by the zoom shortcuts. */
  fontScale: number
  workingStartedAt?: number | null
  /** Recorded turn durations keyed by user message id (the host's, or the transcript's).
   *  A turn missing here shows the duration this list observed, if it saw the turn run. */
  settledTurns?: NativeChatSettledTurns
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
  deliveryNotices?: ReadonlyMap<string, NativeChatDeliveryNotice>
  /** Set while the turn waits on the reader; the live activity line yields to it. */
  awaitingInput?: NativeChatAwaitingInput | null
  turnActivity?: NativeChatTurnActivity | null
  runtimeContext?: RuntimeFileOperationArgs | null
}): React.JSX.Element {
  const [navigationRequest, setNavigationRequest] = useState<NativeChatNavigationRequest | null>(
    null
  )
  const navigationSequence = useRef(0)
  const revealedDiff = navigationRequest?.kind === 'diff' ? navigationRequest.target : null
  const railJump = navigationRequest?.kind === 'rail' ? navigationRequest : null
  const receipts = useMemo(
    () => (journalItems ? structuredQuestionTranscript(journalItems).receipts : new Map()),
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
  // No paging from a pending or errored read: the lane would no-op, and its recovery
  // remounts the row, which re-checks the range.
  const showOlderHistory = hasMore && session.readPhase === 'ready'

  const projectMessages = useMemo(
    () => createNativeChatMessageListProjection(),
    // Rebound sessions must release the previous transcript's cached rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.agent, session.sessionId]
  )
  const messages = useMemo(() => {
    const projected = projectNativeChatTaskListFrames(projectMessages(session.messages))
    // Structured sessions show goal state in the banner above the composer.
    return journalItems ? omitNativeChatThreadGoalRows(projected) : projected
  }, [journalItems, projectMessages, session.messages])
  const subagentLabels = useMemo(() => nativeChatSubagentLabels(messages), [messages])
  const taskListPredecessors = useMemo(() => nativeChatTaskListPredecessors(messages), [messages])
  const taskListState = useMemo(() => nativeChatTaskListState(messages), [messages])
  // Each row's turn, which turn is live, and the order the rows draw in, resolved once.
  const {
    messages: rows,
    turnKeys,
    liveTurnKey
  } = useNativeChatTurnMembership(messages, journalItems, journalSubmissions)
  const turnDiffs = useMemo(
    () =>
      journalItems ? nativeChatTurnDiffs(rows, turnKeys) : new Map<string, NativeChatTurnDiff>(),
    [journalItems, rows, turnKeys]
  )
  // "Thinking" is real reasoning content at the tail of the turn, not the absence
  // of output — the latter reports thinking while the request is merely in flight.
  const thinking = useMemo(
    () => (journalItems ? isStructuredAgentSessionThinking(journalItems) : false),
    [journalItems]
  )
  const turnStatuses = useNativeChatTurnStatus({
    turnKeys,
    liveTurnKey,
    isWorking,
    workingStartedAt,
    settledTurns,
    thinking
  })
  // The transcript tail: what the running turn is doing, or that it waits on a
  // prompt nothing else on screen shows. A prompt card says so itself.
  const tailRow =
    awaitingInput === 'unshown'
      ? 'awaiting-input'
      : isWorking && awaitingInput === null
        ? 'activity'
        : null
  const lifecycleWorking = session.transcriptLifecycle?.state === 'working'
  const allSlots = useMemo(
    () =>
      buildNativeChatTranscriptSlots({
        messages: rows,
        turnKeys,
        liveTurnKey,
        receipts,
        turnStatuses,
        turnDiffs,
        expandedTurnKeys: expandedTurnIds,
        isWorking,
        lifecycleWorking,
        subagentLabels
      }),
    [
      liveTurnKey,
      expandedTurnIds,
      isWorking,
      lifecycleWorking,
      receipts,
      rows,
      subagentLabels,
      turnDiffs,
      turnKeys,
      turnStatuses
    ]
  )
  // A message waiting behind the live turn draws after that turn's live activity, not inside it.
  const { slots, waitingSlots } = useMemo(
    () => splitNativeChatSlotsWaitingBehindLiveTurn(allSlots, journalItems),
    [allSlots, journalItems]
  )
  const transcriptWindow = useNativeChatTranscriptWindow({
    scrollRef,
    slots,
    isVisible,
    // One pin serves both: revealing a diff and jumping from the rail are
    // mutually exclusive things to be doing.
    revealIndex: nativeChatSlotIndexOf(slots, railJump?.messageId ?? revealedDiff?.messageId)
  })
  const { showJump, onScroll, scrollToBottom, scrollMessageToTop } = useNativeChatTranscriptScroll({
    scrollRef,
    contentRef,
    itemCount: slots.length,
    isWorking,
    showsTailRow: tailRow !== null,
    isVisible,
    alignToViewportTop: transcriptWindow.alignToViewportTop,
    scrollToEnd: transcriptWindow.scrollToEnd,
    restoreScrollOffset: transcriptWindow.restoreScrollOffset,
    consumeProgrammaticScroll: transcriptWindow.consumeProgrammaticScroll,
    reconcileReaderScroll: transcriptWindow.reconcileReaderScroll
  })
  const olderHistory = useNativeChatOlderHistoryAutoload({
    scrollRef,
    historyKey: `${session.agent}:${session.sessionId ?? ''}:${session.olderHistoryGeneration}`,
    isVisible,
    hasMore: showOlderHistory,
    loadingEarlier,
    loadEarlier
  })
  const rail = useNativeChatMessageRail({
    scrollRef,
    slots,
    virtualItems: transcriptWindow.virtualItems,
    outline: railOutline
  })
  const servicedRailJumpRef = useRef(0)
  const requestRailJump = useCallback((item: NativeChatRailItem) => {
    navigationSequence.current += 1
    setNavigationRequest({
      kind: 'rail',
      messageId: item.id,
      requestId: navigationSequence.current
    })
  }, [])
  const railHistoryJump = useNativeChatRailHistoryJump({
    items: rail.items,
    sessionKey: `${session.agent}:${session.sessionId}`,
    loadEarlier,
    jumpToLoaded: requestRailJump
  })
  const { start: startHistoryJump, abort: beginNavigation } = railHistoryJump
  // Every navigation begins by aborting a history jump still paging, which would
  // otherwise land later and pull the reader away from where they just went.
  const selectRailItem = useCallback(
    (item: NativeChatRailItem) => {
      if (item.slotIndex === null) {
        startHistoryJump(item)
        return
      }
      beginNavigation()
      requestRailJump(item)
    },
    [beginNavigation, requestRailJump, startHistoryJump]
  )
  const revealDiff = useCallback(
    (target: NativeChatDiffTarget) => {
      beginNavigation()
      navigationSequence.current += 1
      setNavigationRequest({
        kind: 'diff',
        target: { ...target, requestId: navigationSequence.current }
      })
    },
    [beginNavigation]
  )
  const jumpToLatest = useCallback(() => {
    beginNavigation()
    scrollToBottom()
  }, [beginNavigation, scrollToBottom])
  const readerScrollInput = useMemo(
    () => nativeChatReaderScrollInputHandlers(beginNavigation),
    [beginNavigation]
  )
  // Pinning the target mounts it in the same commit, so the row exists by the time
  // layout runs. Routed through `scrollMessageToTop` rather than the virtualizer
  // because that is what releases the bottom pin — without it the next streamed
  // token snaps the reader straight back down.
  //
  // Serviced once per request, then released. `slots` takes a new identity on
  // every render, so an effect that merely depended on it would re-scroll to this
  // row forever; and a request left standing would keep its pin, which outranks
  // the diff reveal that shares it.
  useLayoutEffect(() => {
    if (railJump === null || servicedRailJumpRef.current === railJump.requestId) {
      return
    }
    servicedRailJumpRef.current = railJump.requestId
    const index = nativeChatSlotIndexOf(slots, railJump.messageId)
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)
    if (row) {
      scrollMessageToTop(row)
    }
    setNavigationRequest(null)
  }, [railJump, scrollMessageToTop, slots])

  const rowContext = useMemo<NativeChatTranscriptRowContext>(
    () => ({
      expandSignal,
      revealedDiff,
      taskListPredecessors,
      expandedTurnIds,
      deliveryNotices,
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
      deliveryNotices,
      onLinkClick,
      revealDiff,
      revealedDiff,
      runtimeContext,
      scrollMessageToTop,
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
            {...readerScrollInput}
            // Named so measurement can find the scroll root without depending on
            // which utility class happens to make it scroll.
            data-native-chat-scroll
            // Browser anchoring would add unattributed movement beside the virtualizer's anchor.
            className="scrollbar-sleek relative h-full overflow-y-auto [overflow-anchor:none] [scrollbar-gutter:stable_both-edges]"
            // Why: `zoom` scales the chat transcript's text and layout together,
            // scoped to this pane so the rest of the app is untouched. It sits on
            // the scroll container rather than the content inside it so that
            // scroll offsets and row measurements share one coordinate space —
            // measuring zoomed content against an unzoomed scroller misplaces the
            // window by exactly `fontScale`. (Chromium/Electron only.)
            style={{ zoom: fontScale }}
          >
            {showOlderHistory ? (
              <NativeChatOlderHistoryRow
                olderHistory={olderHistory}
                loadingEarlier={loadingEarlier}
              />
            ) : null}
            <div className="px-3 pt-10 pb-4 sm:px-4">
              <div
                ref={contentRef}
                // Why: matches composer column (max-w-4xl) with 5px horizontal inset
                // on each side so content is slightly narrower than the input box.
                className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-[5px]"
              >
                <NativeChatTranscriptItems
                  slots={slots}
                  context={rowContext}
                  window={transcriptWindow}
                />
                {tailRow === 'activity' ? (
                  <NativeChatTurnActivityLine
                    activity={turnActivity}
                    thinking={turnStatuses.active?.thinking === true}
                  />
                ) : tailRow === 'awaiting-input' ? (
                  <NativeChatAwaitingInputRow subject={null} pending />
                ) : null}
                <NativeChatWaitingTranscriptItems slots={waitingSlots} context={rowContext} />
              </div>
            </div>
          </div>
          <NativeChatMessageRail
            rail={rail}
            scrollRef={scrollRef}
            onSelect={selectRailItem}
            onReaderScroll={beginNavigation}
            pendingId={railHistoryJump.pendingId}
          />
          {showJump ? (
            <button
              type="button"
              onClick={jumpToLatest}
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
