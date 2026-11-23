import type { NativeChatMessageListProps } from './native-chat-message-list-props'
import { nativeChatTranscriptOuterClass } from './appearance/native-chat-appearance-style'
import { NativeChatTranscriptViewport } from './NativeChatTranscriptViewport'
import { NativeChatTranscriptColumn } from './NativeChatTranscriptColumn'
import { NativeChatNewRowsAnnouncement } from './viewport/new-rows/NativeChatNewRowsMarker'
import { useNativeChatNewRowsMarker } from './viewport/new-rows/native-chat-new-rows-marker'
import { useNativeChatRowTypography } from './viewport/virtualization/use-native-chat-row-typography'
import { withoutPullRequestEventRows } from '../../../../shared/native-chat/transcript/notices/native-chat-pull-request-event'
import { useCallback, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import {
  nativeChatShowsCiResultLines,
  nativeChatShowsTurnDiffSummary
} from '../../../../shared/native-chat/settings/native-chat-appearance-settings'
import { useNativeChatTranscriptProjection } from './conversation/projection/use-native-chat-transcript-projection'
import { useNativeChatQuestionReceipts } from './conversation/projection/use-native-chat-question-receipts'
import { nativeChatTaskListPredecessors } from '../../../../shared/native-chat/input/task-lists/native-chat-task-list-history'
import { NativeChatDockedTaskList } from './tools/tasks/NativeChatDockedTaskList'
import { useNativeChatTurnStatus } from './conversation/turns/use-native-chat-turn-status'
import { NativeChatAwaitingInputRow } from './prompts/NativeChatAwaitingInputRow'
import { NativeChatTurnActivityLine } from './messages/reasoning/NativeChatTurnActivityLine'
import {
  NativeChatTranscriptItems,
  NativeChatWaitingTranscriptItems
} from './viewport/virtualization/NativeChatTranscriptItems'
import { useNativeChatTranscriptRowContext } from './conversation/slots/use-native-chat-transcript-row-context'
import { splitNativeChatSlotsWaitingBehindLiveTurn } from './conversation/slots/native-chat-transcript-slot-selection'
import { useNativeChatTranscriptSlots } from './conversation/slots/use-native-chat-transcript-slots'
import { useNativeChatTranscriptWindow } from './viewport/virtualization/use-native-chat-transcript-window'
import { useNativeChatHistoryRetention } from './viewport/history/use-native-chat-history-retention'
import { useNativeChatSubagentScope } from './subagents/use-native-chat-subagent-scope'
import type { NativeChatTranscriptSlot } from './conversation/slots/native-chat-transcript-slots'
import {
  useNativeChatSideChatForkOffer,
  useNativeChatSideChatForkPointReport
} from './messages/actions/use-native-chat-side-chat'
import { useNativeChatTranscriptScroll } from './viewport/scroll/use-native-chat-transcript-scroll'
import { useNativeChatOlderHistoryAutoload } from './viewport/history/use-native-chat-older-history-autoload'
import { NativeChatOlderHistoryRow } from './viewport/history/NativeChatOlderHistoryRow'
import { useNativeChatMessageRail } from './viewport/rail/use-native-chat-message-rail'
import { NativeChatMessageRail } from './viewport/rail/NativeChatMessageRail'
import { useNativeChatRailWake } from './viewport/rail/use-native-chat-rail-wake'
import {
  useNativeChatNavigation,
  useNativeChatNavigationRequest
} from './viewport/navigation/use-native-chat-transcript-navigation'
import { useNativeChatReaderScrollInput } from './viewport/scroll/native-chat-reader-scroll-input'
import { useNativeChatMessageListHandle } from './messages/actions/use-native-chat-reveal-latest'

import { isStructuredAgentSessionThinking } from '../../../../shared/agent-session/view/structured-agent-session-live-turn'
import { useNativeChatTurnDiffs } from './tools/diffs/use-native-chat-turn-diffs'
import { useNativeChatTurnOpenedPullRequests } from './tools/pull-requests/use-native-chat-turn-opened-pull-requests'
import { NativeChatPullRequestChangeContext } from './tools/pull-requests/NativeChatOpenedPullRequestCard'
import { transcriptTailRow } from './conversation/slots/native-chat-transcript-tail-row'
import { useRereadWorkersOnNewRows } from './native-chat-workers-context'
import { NativeChatBotHomeScope } from './NativeChatBotHomeScope'

const NO_SLOTS: readonly NativeChatTranscriptSlot[] = []

export function NativeChatMessageList({
  ref,
  session,
  journalItems,
  journalSubmissions,
  journalLatestTurn: latestTurn,
  journalHostWork: hostWork,
  subagentRoster,
  subagentView,
  railOutline = null,
  isVisible = true,
  isWorking,
  expandSignal,
  workingStartedAt,
  settledTurns,
  deliveryNotices,
  timedRows,
  awaitingInput = null,
  turnActivity,
  stopping = false,
  runtimeContext,
  botHome,
  turnBot,
  structuredAttachments = false
}: NativeChatMessageListProps): React.JSX.Element {
  const receipts = useNativeChatQuestionReceipts(journalItems)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)

  const { hasMore, loadingEarlier, loadEarlier } = session
  const historyRetention = useNativeChatHistoryRetention({
    ...session,
    isVisible,
    root: contentRef,
    sourceKey: `${session.agent}:${session.sessionId}`
  })

  const { messages: conversation, subagentRows } = useNativeChatTranscriptProjection(
    session,
    journalItems,
    journalSubmissions,
    latestTurn
  )
  const scope = useNativeChatSubagentScope({
    view: subagentView,
    conversation,
    subagentRows,
    roster: subagentRoster,
    journalItems,
    journalSubmissions,
    latestTurn,
    isWorking
  })
  const { agentId: subagentId, messages, turnRows, working, rowsInOrder } = scope
  useRereadWorkersOnNewRows(journalItems?.length ?? 0)
  // Pending/failed reads cannot page; recovery remounts the sentinel to recheck its range.
  const showOlderHistory = hasMore && session.readPhase === 'ready' && scope.pagesHistory
  const loadedMessageIds = useMemo(() => new Set(messages.map(({ id }) => id)), [messages])
  const taskListPredecessors = useMemo(() => nativeChatTaskListPredecessors(messages), [messages])
  const { liveTurnKey } = turnRows
  const showCiResultLines = useAppStore((state) => nativeChatShowsCiResultLines(state.settings))
  // Hidden lines leave the transcript entirely, so they reserve no row or gap.
  const { messages: rows, turnKeys } = useMemo(
    () => (showCiResultLines ? turnRows : withoutPullRequestEventRows(turnRows)),
    [showCiResultLines, turnRows]
  )
  const latestTurnKey = turnKeys.findLast((key) => key !== undefined)
  const showTurnDiffs = useAppStore((state) => nativeChatShowsTurnDiffSummary(state.settings))
  const turns = scope.conversationTurns
  const turnDiffs = useNativeChatTurnDiffs(showTurnDiffs && !turnBot ? turns : null, rowsInOrder)
  const openedPullRequests = useNativeChatTurnOpenedPullRequests(turns, rowsInOrder)
  // Only real tail reasoning counts as thinking; an in-flight request with no output does not.
  const thinking = useMemo(
    () =>
      subagentId === null &&
      isStructuredAgentSessionThinking({ items: journalItems ?? [], latestTurn }),
    [journalItems, latestTurn, subagentId]
  )
  // The clock starts once the opening message lands, not while it still says "Sending…".
  const turnWorking =
    working && (liveTurnKey === undefined || deliveryNotices?.get(liveTurnKey)?.sending !== true)
  const turnStatuses = useNativeChatTurnStatus({
    turnKeys,
    liveTurnKey,
    isWorking: turnWorking,
    workingStartedAt,
    settledTurns,
    thinking
  })
  // Only unshown prompts need a waiting tail row; prompt cards explain their own wait.
  const tailRow = transcriptTailRow(turnWorking, awaitingInput)
  const lifecycleWorking = subagentId === null && session.transcriptLifecycle?.state === 'working'
  const { measureContent, typography } = useNativeChatRowTypography(contentRef)
  const forkOffer = useNativeChatSideChatForkOffer(latestTurnKey)
  const transcript = useNativeChatTranscriptSlots({
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
    isWorking: working,
    lifecycleWorking,
    subagentHeads: scope.heads,
    forkOffer,
    line: {
      tailRow,
      thinking: turnStatuses.active?.thinking === true,
      stopping,
      activityText: turnActivity?.text
    }
  })
  const {
    slots: allSlots,
    liveLine,
    expandedTurnKeys: historyExpandedTurns,
    toggleExpandedTurn
  } = transcript
  useNativeChatSideChatForkPointReport(transcript.forkPoint)
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
  const navigationRequest = useNativeChatNavigationRequest(slots)
  const newRows = useNativeChatNewRowsMarker(
    slots,
    waitingSlots,
    isVisible && session.readCurrent === true
  )
  const transcriptWindow = useNativeChatTranscriptWindow({
    scrollRef,
    slots,
    messages: session.messages,
    isVisible,
    // Rail jumps, diff reveals and subagent reveals share one mutually exclusive pin.
    revealIndex: navigationRequest.revealIndex,
    newRowsMarkerIndex: newRows.index,
    typography
  })
  const transcriptScroll = useNativeChatTranscriptScroll({
    scrollRef,
    contentRef,
    itemCount: slots.length,
    isWorking: working,
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
    // The rail outlines the conversation's prompts; a subagent's view has none.
    slots: subagentId === null ? slots : NO_SLOTS,
    turnRows,
    virtualItems: transcriptWindow.virtualItems,
    outline: railOutline
  })
  const navigation = useNativeChatNavigation({
    request: navigationRequest,
    rail,
    slots,
    conversation,
    subagentRows,
    roster: subagentRoster,
    journalItems,
    subagentId,
    sessionKey: `${session.agent}:${session.sessionId}`,
    sessionId: session.sessionId,
    ready: session.readPhase === 'ready',
    isVisible,
    loadEarlier: olderHistory.loadEarlier,
    holdHistory: historyRetention.leaveEnd,
    releaseHistory: historyRetention.returnToEnd,
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
  useNativeChatMessageListHandle(ref, {
    readerAtEnd,
    beginNavigation,
    scrollToBottom,
    onSent: newRows.dismiss,
    revealFindMatch: readerInput.revealFindMatch,
    slots: allSlots
  })

  const rowContext = useNativeChatTranscriptRowContext({
    agent: session.agent,
    turnBot,
    hostWork,
    structuredAttachments,
    expandSignal,
    revealedDiff: navigationRequest.revealedDiff,
    taskListPredecessors,
    expandedTurnIds: historyExpandedTurns,
    latestTurnKey,
    deliveryNotices,
    runtimeContext,
    onToggleExpandedTurn: toggleExpandedTurn,
    onOpenSubagent: scope.open,
    onScrollMessageToTop: scrollMessageToTop,
    readerAtEnd,
    onRevealDiff: navigation.revealDiff
  })

  return (
    <NativeChatBotHomeScope kickoff={botHome} isVisible={isVisible}>
      <NativeChatPullRequestChangeContext.Provider value={openedPullRequests.latestChangeKey}>
        <div className="relative flex min-h-0 flex-1 flex-col bg-chat-pane">
          {scope.bar}
          <NativeChatTranscriptViewport
            scrollRef={scrollRef}
            scrollerProps={{ onScroll: onTranscriptScroll, ...readerInput.scrollerProps }}
            forwardedGesture={readerInput.forwardedGesture}
            showJump={showJump}
            onJump={jumpToLatest}
            label={scope.regionLabel}
            overlays={
              <>
                <NativeChatMessageRail
                  rail={rail}
                  railRef={railRef}
                  scrollRef={scrollRef}
                  onSelect={navigation.selectRailItem}
                  onReaderScroll={readerInput.railWheel}
                  pendingId={navigation.pendingRailId}
                />
                <NativeChatNewRowsAnnouncement marked={newRows.marker !== undefined} />
              </>
            }
          >
            {showOlderHistory ? (
              <NativeChatOlderHistoryRow
                olderHistory={olderHistory}
                loadingEarlier={loadingEarlier}
              />
            ) : null}
            <div className={nativeChatTranscriptOuterClass(rail.visible)}>
              <NativeChatTranscriptColumn ref={measureContent}>
                {scope.lead}
                <NativeChatTranscriptItems
                  slots={slots}
                  timedRows={timedRows}
                  loadedMessageIds={loadedMessageIds}
                  context={rowContext}
                  window={transcriptWindow}
                  newRowsMarker={newRows.marker}
                />
                {liveLine ? (
                  <NativeChatTurnActivityLine line={liveLine} />
                ) : tailRow === 'awaiting-input' ? (
                  <NativeChatAwaitingInputRow subject={null} pending />
                ) : null}
                <NativeChatWaitingTranscriptItems slots={waitingSlots} context={rowContext} />
              </NativeChatTranscriptColumn>
            </div>
          </NativeChatTranscriptViewport>
          <NativeChatDockedTaskList key={session.sessionId} messages={messages} />
        </div>
      </NativeChatPullRequestChangeContext.Provider>
    </NativeChatBotHomeScope>
  )
}
