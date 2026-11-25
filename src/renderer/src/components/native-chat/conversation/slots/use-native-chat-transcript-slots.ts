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
import { nativeChatApplyCarriedRunDisclosures } from './native-chat-carried-run-disclosures'
import {
  NO_HEAD_TRACK,
  NO_TURNS,
  nativeChatNextHeadTrack,
  withTurns,
  type NativeChatHeadTrack
} from './native-chat-held-open-turns'
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
  loadingOlder = false,
  ...input
}: Omit<NativeChatTranscriptSlotsInput, 'liveReasoningId' | 'workers'> & {
  /** Receives turns kept open because an older page would fold work the reader was looking at. */
  setExpandedTurnKeys?: (update: (current: ReadonlySet<string>) => ReadonlySet<string>) => void
  /** The reader is paging older history in (by scrolling up or asking). */
  loadingOlder?: boolean
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
  // A held turn draws as the reader's own expanded turn until their expanded turns hold it.
  const drawnExpandedTurnKeys = withTurns(expandedTurnKeys, head.held)
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
  const { slots, forkPoint, quietTurnKeys } = useMemo(() => {
    const built = streamedTranscript(buildInput, saved, messages)
    return { ...built, slots: nativeChatApplyCarriedRunDisclosures(built.slots, head.carried) }
  }, [streamedTranscript, buildInput, saved, messages, head.carried])
  // Only when the first row changes (mount, an older page) does this look back at the head.
  if (head.build === null || head.build.messages[0]?.id !== messages[0]?.id) {
    setHead(
      nativeChatNextHeadTrack(
        head,
        { ...buildInput, messages, expandedTurnKeys },
        slots,
        loadingOlder
      )
    )
  } else if (loadingOlder && !head.paging) {
    setHead({ ...head, paging: true })
  } else if (head.held.size > 0 && [...head.held].every((key) => expandedTurnKeys.has(key))) {
    // The reader's expanded turns now hold them, so their status row folds them as usual.
    setHead({ ...head, held: NO_TURNS })
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
      setExpandedTurnKeys?.((current) => withTurns(current, head.held))
    }
  }, [head.held, setExpandedTurnKeys])
  return { slots, forkPoint, liveLine }
}
