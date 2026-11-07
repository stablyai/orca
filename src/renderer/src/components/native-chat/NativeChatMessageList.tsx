import { copyChatMathSelection } from '../sidebar/chat-markdown-math-selection'
import {
  nativeChatTranscriptOuterClass,
  NATIVE_CHAT_TRANSCRIPT_COLUMN_CLASS
} from './native-chat-appearance-style'
import { NativeChatJumpToLatest } from './NativeChatJumpToLatest'
import { useNativeChatRowTypography } from './use-native-chat-row-typography'
import { useCallback, useMemo, useRef } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  nativeChatScrollsToLatestOnSend,
  nativeChatShowsTurnDiffSummary
} from '../../../../shared/native-chat/native-chat-appearance-settings'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { useNativeChatTranscriptProjection } from './use-native-chat-transcript-projection'
import { desktopStructuredTranscript } from './structured-agent-session-message-projection'
import { nativeChatTaskListPredecessors } from '../../../../shared/native-chat/input/native-chat-task-list-history'
import { NativeChatDockedTaskList } from './NativeChatDockedTaskList'
import { useNativeChatTurnStatus } from './use-native-chat-turn-status'
import { NativeChatAwaitingInputRow } from './NativeChatAwaitingInputRow'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import type { NativeChatTurnActivity } from '../../../../shared/native-chat/transcript/native-chat-turn-activity'
import { NativeChatTurnActivityLine } from './NativeChatTurnActivityLine'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from './native-chat-disclosure-store'
import {
  NativeChatTranscriptItems,
  NativeChatWaitingTranscriptItems
} from './NativeChatTranscriptItems'
import { useNativeChatTranscriptRowContext } from './use-native-chat-transcript-row-context'
import type { StructuredAgentSessionHostWork } from './use-structured-agent-session-transport-state'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'
import { splitNativeChatSlotsWaitingBehindLiveTurn } from './native-chat-transcript-slots'
import { useNativeChatTranscriptSlots } from './use-native-chat-transcript-slots'
import { useNativeChatTranscriptWindow } from './use-native-chat-transcript-window'
import { useNativeChatHistoryRetention } from './use-native-chat-history-retention'
import { useNativeChatSubagentSections } from './use-native-chat-subagent-sections'
import { useNativeChatTurnMembership } from './use-native-chat-turn-membership'
import { useNativeChatTranscriptScroll } from './use-native-chat-transcript-scroll'
import { useNativeChatOlderHistoryAutoload } from './use-native-chat-older-history-autoload'
import { NativeChatOlderHistoryRow } from './NativeChatOlderHistoryRow'
import { useNativeChatMessageRail } from './use-native-chat-message-rail'
import { NativeChatMessageRail } from './NativeChatMessageRail'
import { useNativeChatRailWake } from './use-native-chat-rail-wake'
import type { NativeChatRailOutlineEntry } from './native-chat-message-rail-items'
import {
  useNativeChatNavigation,
  useNativeChatNavigationRequest
} from './use-native-chat-transcript-navigation'
import { useNativeChatReaderScrollInput } from './native-chat-reader-scroll-input'
import { useNativeChatMessageListHandle } from './use-native-chat-reveal-latest'

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionLatestTurn } from '../../../../shared/agent-session/agent-session-wire'
import { isStructuredAgentSessionThinking } from '../../../../shared/agent-session/view/structured-agent-session-live-turn'
import type { NativeChatSettledTurns } from '../../../../shared/native-chat/transcript/native-chat-turn-status'
import { useNativeChatTurnDiffs } from './use-native-chat-turn-diffs'
import { useNativeChatTurnOpenedPullRequests } from './use-native-chat-turn-opened-pull-requests'
import { NativeChatPullRequestChangeContext } from './NativeChatOpenedPullRequestCard'
import { transcriptTailRow } from './native-chat-transcript-tail-row'
import type { NativeChatAwaitingInput } from '../../../../shared/native-chat/native-chat-terminal-turn'

export function NativeChatMessageList({
  ref,
  session,
  journalItems,
  journalSubmissions,
  journalLatestTurn: latestTurn,
  journalHostWork: hostWork,
  subagentRoster,
  railOutline = null,
  isVisible = true,
  isWorking,
  expandSignal,
  workingStartedAt,
  settledTurns,
  deliveryNotices,
  awaitingInput = null,
  turnActivity,
  stopping = false,
  runtimeContext,
  structuredAttachments = false
}: {
  ref?: Parameters<typeof useNativeChatMessageListHandle>[0]
  session: NativeChatLiveSession
  structuredAttachments?: boolean
  journalItems?: readonly AgentJournalRenderItem[]
  /** With the items, what places each row in its turn (structured lane). */
  journalSubmissions?: readonly AgentJournalSubmission[]
  /** The host's newest turn record, which places a live turn whose record is not loaded. */
  journalLatestTurn?: AgentSessionLatestTurn | null
  /** The host's prompts still waiting on the person and its working answer (an older host: none). */
  journalHostWork?: StructuredAgentSessionHostWork
  /** Every subagent the session's rosters named, whether or not its roster row is loaded. */
  subagentRoster?: Parameters<typeof useNativeChatSubagentSections>[2]
  /** User messages older than the loaded window, from the host's outline. */
  railOutline?: readonly NativeChatRailOutlineEntry[] | null
  isVisible?: boolean
  isWorking: boolean
  /** Toolbar-driven desired open state for every tool run; each flip re-syncs. */
  expandSignal: boolean
  workingStartedAt?: number | null
  /** Host durations by prompt id; otherwise fall back to a duration observed locally. */
  settledTurns?: NativeChatSettledTurns
  deliveryNotices?: ReadonlyMap<string, NativeChatDeliveryNotice>
  /** Set while the turn waits on the reader; the live activity line yields to it. */
  awaitingInput?: NativeChatAwaitingInput | null
  turnActivity?: NativeChatTurnActivity | null
  /** A person's Stop is ending the live turn: its tail line reads "Stopping…". */
  stopping?: boolean
  runtimeContext?: RuntimeFileOperationArgs | null
}): React.JSX.Element {
  const receipts = useMemo(
    () =>
      journalItems ? desktopStructuredTranscript.transcript(journalItems).receipts : new Map(),
    [journalItems]
  )
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const disclosures = useNativeChatDisclosures()

  const { hasMore, loadingEarlier, loadEarlier } = session
  const historyRetention = useNativeChatHistoryRetention({
    ...session,
    isVisible,
    root: contentRef,
    sourceKey: `${session.agent}:${session.sessionId}`
  })
  // Pending/failed reads cannot page; recovery remounts the sentinel to recheck its range.
  const showOlderHistory = hasMore && session.readPhase === 'ready'

  const { messages, subagentRows } = useNativeChatTranscriptProjection(
    session,
    journalItems,
    journalSubmissions,
    latestTurn
  )
  const {
    sections: subagentSections,
    subagentRowsInOrder,
    subagentChoices,
    subagentDisclosure,
    openSubagentSections
  } = useNativeChatSubagentSections(messages, subagentRows, subagentRoster)
  // Folded subagent rows stay loaded, so a reopened reply keeps its reveal.
  const loadedMessageIds = useMemo(
    () => new Set([...messages.map(({ id }) => id), ...subagentSections.pathOf.keys()]),
    [messages, subagentSections]
  )
  const taskListPredecessors = useMemo(() => nativeChatTaskListPredecessors(messages), [messages])
  const turnRows = useNativeChatTurnMembership(
    messages,
    journalItems,
    journalSubmissions,
    latestTurn
  )
  const { messages: rows, turnKeys, liveTurnKey } = turnRows
  const showTurnDiffs = useAppStore((state) => nativeChatShowsTurnDiffSummary(state.settings))
  const turnDiffs = useNativeChatTurnDiffs(
    showTurnDiffs ? turnRows : null,
    subagentRowsInOrder,
    subagentSections.pathOf
  )
  const openedPullRequests = useNativeChatTurnOpenedPullRequests(turnRows, subagentRowsInOrder)
  // Only real tail reasoning counts as thinking; an in-flight request with no output does not.
  const thinking = useMemo(
    () => isStructuredAgentSessionThinking({ items: journalItems ?? [], latestTurn }),
    [journalItems, latestTurn]
  )
  const turnStatuses = useNativeChatTurnStatus({
    turnKeys,
    liveTurnKey,
    isWorking,
    workingStartedAt,
    settledTurns,
    thinking
  })
  // Only unshown prompts need a waiting tail row; prompt cards explain their own wait.
  const tailRow = transcriptTailRow(isWorking, awaitingInput)
  const { measureContent, typography } = useNativeChatRowTypography(contentRef)
  const {
    slots: allSlots,
    liveLine,
    expandedTurnKeys: historyExpandedTurns,
    toggleExpandedTurn
  } = useNativeChatTranscriptSlots({
    scopeKey: `${session.agent}:${session.sessionId ?? ''}`,
    historyHead: journalItems?.[0]?.itemId,
    typography,
    messages: rows,
    unresolvedRowIds: turnRows.unresolvedRowIds,
    turnKeys,
    liveTurnKey,
    receipts,
    turnStatuses,
    turnDiffs,
    openedPullRequests: openedPullRequests.byTurn,
    isWorking,
    lifecycleWorking: session.transcriptLifecycle?.state === 'working',
    subagentSections,
    subagentChoices,
    line: {
      draws: tailRow === 'activity',
      thinking: turnStatuses.active?.thinking === true,
      stopping,
      activityText: turnActivity?.text
    }
  })
  // A message waiting behind the live turn draws after that turn's live activity, not inside it.
  const { slots, waitingSlots } = useMemo(
    () =>
      splitNativeChatSlotsWaitingBehindLiveTurn(
        allSlots,
        journalItems,
        stopping,
        journalSubmissions,
        { latestTurn, ...hostWork }
      ),
    [allSlots, journalItems, stopping, journalSubmissions, latestTurn, hostWork]
  )
  const navigationRequest = useNativeChatNavigationRequest(slots, messages, subagentSections)
  const transcriptWindow = useNativeChatTranscriptWindow({
    scrollRef,
    slots,
    messages: session.messages,
    isVisible,
    // Rail jumps, diff reveals and subagent reveals share one mutually exclusive pin.
    revealIndex: navigationRequest.revealIndex,
    typography
  })
  const transcriptScroll = useNativeChatTranscriptScroll({
    scrollRef,
    contentRef,
    itemCount: slots.length,
    isWorking,
    showsTailRow: tailRow !== null,
    isVisible,
    alignToViewportTop: transcriptWindow.alignToViewportTop,
    isAlignPending: transcriptWindow.isAlignPending,
    scrollToEnd: transcriptWindow.scrollToEnd,
    restoreScrollOffset: transcriptWindow.restoreScrollOffset,
    consumeProgrammaticScroll: transcriptWindow.consumeProgrammaticScroll,
    reconcileReaderScroll: transcriptWindow.reconcileReaderScroll,
    onLeaveEnd: historyRetention.leaveEnd,
    onReturnToEnd: historyRetention.returnToEnd
  })
  const { showJump, onScroll, scrollToBottom, readerAtEnd, scrollMessageToTop, readerLeavesEnd } =
    transcriptScroll
  const { recordReaderScroll } = transcriptScroll
  const olderHistory = useNativeChatOlderHistoryAutoload({
    scrollRef,
    historyKey: `${session.agent}:${session.sessionId ?? ''}:${session.olderHistoryGeneration}`,
    isVisible,
    hasMore: showOlderHistory,
    autoLoad: historyRetention.autoLoadHistory,
    onManualLoad: readerLeavesEnd,
    loadingEarlier,
    loadEarlier
  })
  const rail = useNativeChatMessageRail({
    scrollRef,
    slots,
    turnRows,
    virtualItems: transcriptWindow.virtualItems,
    outline: railOutline
  })
  const navigation = useNativeChatNavigation({
    request: navigationRequest,
    rail,
    slots,
    conversation: messages,
    sections: subagentSections,
    roster: subagentRoster,
    journalItems,
    openSubagentSections,
    subagentDisclosure,
    sessionKey: `${session.agent}:${session.sessionId}`,
    isVisible,
    loadEarlier,
    scrollRef,
    scrollMessageToTop,
    readerLeavesEnd,
    scrollToBottom
  })
  const { beginNavigation, jumpToLatest } = navigation
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
    onScrollGesture: transcriptScroll.forwardedGesture
  })
  // Off keeps a reader who scrolled up in place; one at the end still follows the reply.
  const revealSent = useCallback(
    (readerWasAtEnd = readerAtEnd()) => {
      if (!nativeChatScrollsToLatestOnSend(useAppStore.getState().settings) && !readerWasAtEnd) {
        return
      }
      beginNavigation()
      scrollToBottom('send')
    },
    [beginNavigation, readerAtEnd, scrollToBottom]
  )
  useNativeChatMessageListHandle(
    ref,
    revealSent,
    readerInput.revealFindMatch,
    allSlots,
    readerAtEnd,
    navigation.revealSubagent
  )

  const rowContext = useNativeChatTranscriptRowContext({
    agent: session.agent,
    hostWork,
    structuredAttachments,
    expandSignal,
    revealedDiff: navigationRequest.revealedDiff,
    taskListPredecessors,
    expandedTurnIds: historyExpandedTurns,
    latestTurnKey: turnKeys.findLast((key) => key !== undefined),
    deliveryNotices,
    runtimeContext,
    onToggleExpandedTurn: toggleExpandedTurn,
    subagentDisclosure,
    onScrollMessageToTop: scrollMessageToTop,
    onRevealDiff: navigation.revealDiff
  })

  return (
    <NativeChatDisclosureContext.Provider value={disclosures}>
      <NativeChatPullRequestChangeContext.Provider value={openedPullRequests.latestChangeKey}>
        <div className="relative flex min-h-0 flex-1 flex-col bg-chat-pane">
          <div className="relative min-h-0 flex-1">
            <div
              ref={scrollRef}
              onScroll={onTranscriptScroll}
              onCopy={copyChatMathSelection}
              {...readerInput.scrollerProps}
              // Measurement finds this named scroll root independently of utility classes.
              data-native-chat-scroll
              aria-label={translate('components.native-chat.transcriptLabel', 'Conversation')}
              // Browser anchoring would add unattributed movement beside the virtualizer's anchor.
              className="scrollbar-sleek relative h-full overflow-y-auto [overflow-anchor:none] [scrollbar-gutter:stable_both-edges] focus-visible:outline-none"
            >
              {showOlderHistory ? (
                <NativeChatOlderHistoryRow
                  olderHistory={olderHistory}
                  loadingEarlier={loadingEarlier}
                />
              ) : null}
              <div className={nativeChatTranscriptOuterClass(rail.visible)}>
                <div
                  ref={measureContent}
                  data-native-chat-transcript-column
                  // Shares the composer's maximum width; rail clearance and the 5px inner inset narrow constrained panes.
                  className={NATIVE_CHAT_TRANSCRIPT_COLUMN_CLASS}
                >
                  <NativeChatTranscriptItems
                    slots={slots}
                    loadedMessageIds={loadedMessageIds}
                    context={rowContext}
                    window={transcriptWindow}
                    forwardGesture={readerInput.forwardedGesture}
                  />
                  {liveLine ? (
                    <NativeChatTurnActivityLine line={liveLine} />
                  ) : tailRow === 'awaiting-input' ? (
                    <NativeChatAwaitingInputRow subject={null} pending />
                  ) : null}
                  <NativeChatWaitingTranscriptItems slots={waitingSlots} context={rowContext} />
                </div>
              </div>
            </div>
            <NativeChatMessageRail
              rail={rail}
              railRef={railRef}
              scrollRef={scrollRef}
              onSelect={navigation.selectRailItem}
              onReaderScroll={readerInput.railWheel}
              pendingId={navigation.pendingRailId}
            />
            <NativeChatJumpToLatest visible={showJump} onJump={jumpToLatest} />
          </div>
          <NativeChatDockedTaskList key={session.sessionId} messages={messages} />
        </div>
      </NativeChatPullRequestChangeContext.Provider>
    </NativeChatDisclosureContext.Provider>
  )
}
