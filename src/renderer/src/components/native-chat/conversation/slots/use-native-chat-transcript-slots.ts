import { NativeChatVisualOwnerContext } from '../../media/visuals/native-chat-visual-owner'
import {
  nativeChatMarkdownImageSources,
  nativeChatVisualMarkdownImageSources
} from '../../markdown/native-chat-markdown-image-sources'
import { useContext, useLayoutEffect, useMemo, useState } from 'react'
import {
  nativeChatLiveLine,
  type NativeChatLiveLine
} from '../../../../../../shared/native-chat/transcript/row-content/native-chat-live-line'
import { isNativeChatRowInLiveWorkingTurn } from '../../../../../../shared/native-chat/transcript/turns/native-chat-live-turn-membership'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'
import type { NativeChatSideChatForkPoint } from '../../messages/actions/native-chat-side-chat-fork-point'
import type { NativeChatTranscriptSlotsInput } from './native-chat-transcript-input'
import { createNativeChatStreamedTranscript } from './native-chat-transcript-streamed-slots'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { useNativeChatWorkers } from '../../native-chat-workers-context'
import type { NativeChatLiveSession } from '../../session/terminal/read/native-chat-live-session-contract'
import { openNativeChatExpandedKeys } from '../../messages/disclosure/native-chat-expanded-keys'
import {
  NO_HEAD_TRACK,
  nativeChatHeadTrackStep,
  type NativeChatHeadTrack
} from './native-chat-head-track'
import {
  NO_LEAVING_TURNS,
  useNativeChatQuietTurnLeave
} from '../turns/use-native-chat-quiet-turn-leave'

/** Choose slots/activity together so reasoning shown by the activity line never also gets a transcript row. */

const NO_ROWS: readonly NativeChatMessage[] = []
export function useNativeChatTranscriptSlots({
  line,
  structureMessages,
  setExpandedTurnKeys,
  history,
  ...input
}: Omit<NativeChatTranscriptSlotsInput, 'liveReasoningId' | 'workers'> & {
  /** Receives turns kept open because an older page would fold work the reader was looking at. */
  setExpandedTurnKeys: (update: (current: ReadonlySet<string>) => ReadonlySet<string>) => void
  /** Whose older history this is (another session or generation starts over), and how many
   *  older-history pages (including the mount prefetch) added rows. Read only here, for this rule. */
  history?: Pick<
    NativeChatLiveSession,
    'agent' | 'sessionId' | 'olderHistoryGeneration' | 'olderPages'
  >
  /** `messages` as of their last change other than a streaming reply's text, row for row. */
  structureMessages?: readonly NativeChatMessage[]
  line: {
    /** The row drawn under the transcript, if any. */
    tailRow: 'awaiting-input' | 'activity' | null
    thinking: boolean
    stopping?: boolean
    activityText?: string | null
  }
}): {
  slots: NativeChatTranscriptSlot[]
  forkPoint: NativeChatSideChatForkPoint | null
  liveLine: NativeChatLiveLine | null
} {
  const visualOwner = useContext(NativeChatVisualOwnerContext)
  const workers = useNativeChatWorkers()
  const imageSources = visualOwner
    ? nativeChatVisualMarkdownImageSources
    : nativeChatMarkdownImageSources
  const {
    messages,
    unresolvedRowIds,
    typography,
    turnKeys,
    liveTurnKey,
    receipts,
    turnStatuses,
    turnDiffs,
    openedPullRequests,
    expandedTurnKeys,
    isWorking,
    lifecycleWorking,
    subagentHeads,
    forkOffer
  } = input
  const { tailRow, thinking, stopping = false, activityText } = line
  const draws = tailRow === 'activity'
  const working = isWorking || lifecycleWorking
  // Which rows are in the live turn is structure: found once per save, not per streamed frame.
  const structureRows = structureMessages?.length === messages.length ? structureMessages : messages
  const liveTurnHasRows = useMemo(
    () =>
      structureRows.some((message, index) =>
        isNativeChatRowInLiveWorkingTurn(
          turnKeys[index],
          liveTurnKey,
          working,
          unresolvedRowIds?.has(message.id)
        )
      ),
    [structureRows, turnKeys, liveTurnKey, working, unresolvedRowIds]
  )
  const liveLine = useMemo(
    () =>
      nativeChatLiveLine({
        draws,
        thinking,
        stopping,
        activityText,
        messages: liveTurnHasRows ? messages : NO_ROWS,
        inLiveWorkingTurn: (index) =>
          isNativeChatRowInLiveWorkingTurn(
            turnKeys[index],
            liveTurnKey,
            working,
            unresolvedRowIds?.has(messages[index]!.id)
          )
      }),
    [
      activityText,
      draws,
      liveTurnHasRows,
      liveTurnKey,
      messages,
      stopping,
      thinking,
      turnKeys,
      unresolvedRowIds,
      working
    ]
  )
  const liveReasoningId = liveLine?.reasoning?.message.id ?? null
  const [leavingTurnKeys, setLeavingTurnKeys] = useState(NO_LEAVING_TURNS)
  // Built from the saved rows, so a live window that only grows a reply rebuilds no structure.
  const saved = structureRows
  const [head, setHead] = useState<NativeChatHeadTrack>(NO_HEAD_TRACK)
  // A held turn draws as the reader's own expanded turn (under the same cap) until theirs hold it.
  const drawnExpandedTurnKeys =
    head.held.size === 0
      ? expandedTurnKeys
      : openNativeChatExpandedKeys(expandedTurnKeys, head.held)
  const buildInput = useMemo(
    () => ({
      imageSources,
      unresolvedRowIds,
      typography,
      turnKeys,
      liveTurnKey,
      receipts,
      turnStatuses,
      turnDiffs,
      openedPullRequests,
      expandedTurnKeys: drawnExpandedTurnKeys,
      ownedRuns: head.owned,
      isWorking,
      lifecycleWorking,
      subagentHeads,
      liveReasoningId,
      forkOffer,
      workers,
      leavingTurnKeys
    }),
    [
      leavingTurnKeys,
      workers,
      drawnExpandedTurnKeys,
      head.owned,
      imageSources,
      forkOffer,
      isWorking,
      lifecycleWorking,
      liveReasoningId,
      liveTurnKey,
      openedPullRequests,
      receipts,
      subagentHeads,
      turnDiffs,
      turnKeys,
      turnStatuses,
      typography,
      unresolvedRowIds
    ]
  )
  const [streamedTranscript] = useState(createNativeChatStreamedTranscript)
  const { slots, forkPoint, quietTurnKeys, runOwners } = useMemo(
    () => streamedTranscript(buildInput, saved, messages),
    [streamedTranscript, buildInput, saved, messages]
  )
  // Only an applied older page can hold a turn or carry a run; anything else keeps the window
  // the next page lands on current.
  const nextHead = nativeChatHeadTrackStep(head, {
    session: history ? `${history.agent}:${history.sessionId}` : undefined,
    generation: history?.olderHistoryGeneration,
    pages: history?.olderPages ?? 0,
    input: { ...buildInput, messages, expandedTurnKeys },
    structure: saved,
    slots,
    owners: runOwners
  })
  if (nextHead !== head) {
    setHead(nextHead)
  }
  useNativeChatQuietTurnLeave({
    quietTurnKeys,
    liveTurnKey,
    working: isWorking || lifecycleWorking,
    leaving: leavingTurnKeys,
    setLeaving: setLeavingTurnKeys
  })
  useLayoutEffect(() => {
    if (head.held.size > 0) {
      setExpandedTurnKeys((current) => openNativeChatExpandedKeys(current, head.held))
    }
  }, [head.held, setExpandedTurnKeys])
  return { slots, forkPoint, liveLine }
}
