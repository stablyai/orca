import {
  nativeChatTranscriptOuterClass,
  NATIVE_CHAT_TRANSCRIPT_COLUMN_CLASS
} from './native-chat-appearance-style'
import { NativeChatJumpToLatest } from './NativeChatJumpToLatest'
import { NativeChatNewRowsAnnouncement } from './NativeChatNewRowsMarker'
import { useNativeChatRowTypography } from './use-native-chat-row-typography'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { translate } from '@/i18n/i18n'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { useNativeChatTranscriptProjection } from './use-native-chat-transcript-projection'
import { structuredQuestionTranscript } from '../../../../shared/structured-agent-question-projection'
import { nativeChatTaskListPredecessors } from '../../../../shared/native-chat-task-list-history'
import { NativeChatDockedTaskList } from './NativeChatDockedTaskList'
import { useNativeChatTurnStatus } from './use-native-chat-turn-status'
import { NativeChatAwaitingInputRow } from './NativeChatAwaitingInputRow'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
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
import { useNativeChatTranscriptRowContext } from './use-native-chat-transcript-row-context'
import type { StructuredAgentSessionHostWork } from './use-structured-agent-session-transport-state'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'
import {
  splitNativeChatSlotsWaitingBehindLiveTurn,
  nativeChatSlotIndexOf
} from './native-chat-transcript-slots'
import { useNativeChatTranscriptSlots } from './use-native-chat-transcript-slots'
import { useNativeChatTranscriptWindow } from './use-native-chat-transcript-window'
import { useNativeChatSubagentSections } from './use-native-chat-subagent-sections'
import { toggleNativeChatExpandedKey } from './native-chat-expanded-keys'
import { useNativeChatTurnMembership } from './use-native-chat-turn-membership'
import { useNativeChatTranscriptScroll } from './use-native-chat-transcript-scroll'
import { useNativeChatNewRowsMarker } from './native-chat-new-rows-marker'
import { useNativeChatOlderHistoryAutoload } from './use-native-chat-older-history-autoload'
import { NativeChatOlderHistoryRow } from './NativeChatOlderHistoryRow'
import { useNativeChatMessageRail } from './use-native-chat-message-rail'
import { NativeChatMessageRail } from './NativeChatMessageRail'
import type {
  NativeChatRailItem,
  NativeChatRailOutlineEntry
} from './native-chat-message-rail-items'
import { useNativeChatRailHistoryJump } from './use-native-chat-rail-history-jump'
import { useNativeChatRailJumpLanding } from './use-native-chat-rail-jump-landing'
import { useNativeChatReaderScrollInput } from './native-chat-reader-scroll-input'
import { useNativeChatMessageListHandle } from './use-native-chat-reveal-latest'

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { AgentSessionLatestTurn } from '../../../../shared/agent-session-wire'
import { isStructuredAgentSessionThinking } from '../../../../shared/structured-agent-session-live-turn'
import type { NativeChatSettledTurns } from '../../../../shared/native-chat-turn-status'
import type { NativeChatDiffReveal, NativeChatDiffTarget } from './native-chat-turn-diffs'
import { useNativeChatTurnDiffs } from './use-native-chat-turn-diffs'
import { transcriptTailRow } from './native-chat-transcript-tail-row'

/** The turn is blocked on the reader. `shown`: the pane draws the prompt itself, as a card;
 *  `unshown`: it cannot (the prompt is only in the agent's terminal). */
export type NativeChatAwaitingInput = 'shown' | 'unshown'

type NavigationRequest =
  | { kind: 'diff'; target: NativeChatDiffReveal }
  | { kind: 'rail'; messageId: string; requestId: number }

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
  onLinkClick,
  allowFileUriLinks = false,
  workingStartedAt,
  settledTurns,
  deliveryNotices,
  awaitingInput = null,
  turnActivity,
  stopping = false,
  runtimeContext
}: {
  ref?: Parameters<typeof useNativeChatMessageListHandle>[0]
  session: NativeChatLiveSession
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
  /** Recorded turn durations keyed by user message id (the host's, or the transcript's).
   *  A turn missing here shows the duration this list observed, if it saw the turn run. */
  settledTurns?: NativeChatSettledTurns
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
  deliveryNotices?: ReadonlyMap<string, NativeChatDeliveryNotice>
  /** Set while the turn waits on the reader; the live activity line yields to it. */
  awaitingInput?: NativeChatAwaitingInput | null
  turnActivity?: NativeChatTurnActivity | null
  /** A person's Stop is ending the live turn: its tail line reads "Stopping…". */
  stopping?: boolean
  runtimeContext?: RuntimeFileOperationArgs | null
}): React.JSX.Element {
  const [navigationRequest, setNavigationRequest] = useState<NavigationRequest | null>(null)
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
    setExpandedTurnIds((current) => toggleNativeChatExpandedKey(current, turnKey))
  }, [])

  const { hasMore, loadingEarlier, loadEarlier } = session
  // No paging from a pending or errored read: the lane would no-op, and its recovery
  // remounts the row, which re-checks the range.
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
  // Each row's turn, which turn is live, and the order the rows draw in, resolved once.
  const turnRows = useNativeChatTurnMembership(
    messages,
    journalItems,
    journalSubmissions,
    latestTurn
  )
  const { messages: rows, turnKeys, liveTurnKey } = turnRows
  const turnDiffs = useNativeChatTurnDiffs(
    journalItems ? turnRows : null,
    subagentRowsInOrder,
    subagentSections.pathOf
  )
  // "Thinking" is real reasoning content at the tail of the turn, not the absence
  // of output — the latter reports thinking while the request is merely in flight.
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
  // The transcript tail: what the running turn is doing, or that it waits on a
  // prompt nothing else on screen shows. A prompt card says so itself.
  const tailRow = transcriptTailRow(isWorking, awaitingInput)
  const lifecycleWorking = session.transcriptLifecycle?.state === 'working'
  const { measureContent, typography } = useNativeChatRowTypography(contentRef)
  const { slots: allSlots, liveLine } = useNativeChatTranscriptSlots({
    typography,
    messages: rows,
    turnKeys,
    liveTurnKey,
    receipts,
    turnStatuses,
    turnDiffs,
    expandedTurnKeys: expandedTurnIds,
    isWorking,
    lifecycleWorking,
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
  const { marker: newRowsMarker, dismiss } = useNativeChatNewRowsMarker(
    slots,
    waitingSlots,
    isVisible && session.readCurrent === true
  )
  const transcriptWindow = useNativeChatTranscriptWindow({
    scrollRef,
    slots,
    isVisible,
    // One pin serves both: revealing a diff and jumping from the rail are
    // mutually exclusive things to be doing.
    revealIndex: nativeChatSlotIndexOf(slots, railJump?.messageId ?? revealedDiff?.messageId),
    newRowsMarkerIndex: nativeChatSlotIndexOf(slots, newRowsMarker?.key),
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
    reconcileReaderScroll: transcriptWindow.reconcileReaderScroll
  })
  const { showJump, onScroll, scrollToBottom, scrollMessageToTop, readerLeavesEnd } =
    transcriptScroll
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
    turnRows,
    virtualItems: transcriptWindow.virtualItems,
    outline: railOutline
  })
  const requestRailJump = useCallback((item: NativeChatRailItem) => {
    navigationSequence.current += 1
    const requestId = navigationSequence.current
    setNavigationRequest({ kind: 'rail', messageId: item.id, requestId })
  }, [])
  const railHistoryJump = useNativeChatRailHistoryJump({
    items: rail.items,
    sessionKey: `${session.agent}:${session.sessionId}`,
    isVisible,
    loadEarlier,
    jumpToLoaded: requestRailJump
  })
  const { start: startHistoryJump, abort: beginNavigation } = railHistoryJump
  // Every navigation begins by aborting a history jump still paging, which would
  // otherwise land later and pull the reader away from where they just went.
  const selectRailItem = useCallback(
    (item: NativeChatRailItem) => {
      beginNavigation()
      readerLeavesEnd()
      if (item.slotIndex === null) {
        startHistoryJump(item)
        return
      }
      requestRailJump(item)
    },
    [beginNavigation, readerLeavesEnd, requestRailJump, startHistoryJump]
  )
  const revealDiff = useCallback(
    (target: NativeChatDiffTarget) => {
      beginNavigation()
      readerLeavesEnd()
      // A subagent's edit is revealed inside its section.
      if (target.subagentSections) {
        openSubagentSections(target.subagentSections)
      }
      navigationSequence.current += 1
      const requestId = navigationSequence.current
      setNavigationRequest({ kind: 'diff', target: { ...target, requestId } })
    },
    [beginNavigation, readerLeavesEnd, openSubagentSections]
  )
  const jumpToLatest = useCallback(() => {
    beginNavigation()
    scrollToBottom()
  }, [beginNavigation, scrollToBottom])
  const readerInput = useNativeChatReaderScrollInput(scrollRef, {
    onReaderScroll: beginNavigation,
    onTakeScroll: transcriptWindow.cancelAlign,
    onLeaveEnd: readerLeavesEnd,
    onScrollGesture: transcriptScroll.forwardedGesture
  })
  useNativeChatMessageListHandle(ref, jumpToLatest, readerInput.revealFindMatch, dismiss, allSlots)
  useNativeChatRailJumpLanding({
    railJump,
    slots,
    scrollRef,
    scrollMessageToTop,
    onActivate: rail.onActivate,
    release: setNavigationRequest
  })

  const rowContext = useNativeChatTranscriptRowContext({
    agent: session.agent,
    hostWork,
    expandSignal,
    revealedDiff,
    taskListPredecessors,
    expandedTurnIds,
    deliveryNotices,
    allowFileUriLinks,
    runtimeContext,
    onLinkClick,
    onToggleExpandedTurn: toggleExpandedTurn,
    subagentDisclosure,
    onScrollMessageToTop: scrollMessageToTop,
    onRevealDiff: revealDiff
  })

  return (
    <NativeChatDisclosureContext.Provider value={disclosures}>
      <div className="relative flex min-h-0 flex-1 flex-col bg-chat-canvas">
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            onScroll={onScroll}
            {...readerInput.scrollerProps}
            // Named so measurement can find the scroll root without depending on
            // which utility class happens to make it scroll.
            data-native-chat-scroll
            aria-label={translate('components.native-chat.transcriptLabel', 'Conversation')}
            // Browser anchoring would add unattributed movement beside the virtualizer's anchor.
            className="scrollbar-sleek relative h-full overflow-y-auto [overflow-anchor:none] [scrollbar-gutter:stable_both-edges] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
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
                  newRowsMarker={newRowsMarker}
                  forwardGesture={readerInput.forwardedGesture}
                />
                {liveLine ? (
                  <NativeChatTurnActivityLine
                    line={liveLine}
                    onLinkClick={onLinkClick}
                    allowFileUriLinks={allowFileUriLinks}
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
            onReaderScroll={readerInput.railWheel}
            pendingId={railHistoryJump.pendingId}
          />
          <NativeChatJumpToLatest visible={showJump} onJump={jumpToLatest} />
          <NativeChatNewRowsAnnouncement marked={newRowsMarker !== undefined} />
        </div>
        <NativeChatDockedTaskList key={session.sessionId} messages={messages} />
      </div>
    </NativeChatDisclosureContext.Provider>
  )
}
