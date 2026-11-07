import { useMemo } from 'react'
import {
  nativeChatLiveLine,
  type NativeChatLiveLine
} from '../../../../shared/native-chat/transcript/native-chat-live-line'
import { isNativeChatRowInLiveWorkingTurn } from '../../../../shared/native-chat/transcript/native-chat-live-turn-membership'
import {
  buildNativeChatTranscript,
  type NativeChatMessageSlot,
  type NativeChatTranscriptSlot
} from './native-chat-transcript-slots'
import type { NativeChatTranscriptSlotsInput } from './native-chat-transcript-input'

/** Choose slots/activity together so reasoning shown by the activity line never also gets a transcript row. */
export function useNativeChatTranscriptSlots({
  line,
  ...input
}: Omit<NativeChatTranscriptSlotsInput, 'liveReasoningId'> & {
  line: { draws: boolean; thinking: boolean; stopping?: boolean; activityText?: string | null }
}): {
  slots: NativeChatTranscriptSlot[]
  responseGroups: NativeChatMessageSlot[][]
  liveLine: NativeChatLiveLine | null
} {
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
    subagentSections,
    subagentChoices
  } = input
  const { draws, thinking, stopping = false, activityText } = line
  const liveLine = useMemo(
    () =>
      nativeChatLiveLine({
        draws,
        thinking,
        stopping,
        activityText,
        messages,
        inLiveWorkingTurn: (index) =>
          isNativeChatRowInLiveWorkingTurn(
            turnKeys[index],
            liveTurnKey,
            isWorking || lifecycleWorking,
            unresolvedRowIds?.has(messages[index]!.id)
          )
      }),
    [
      activityText,
      draws,
      isWorking,
      lifecycleWorking,
      liveTurnKey,
      messages,
      stopping,
      thinking,
      turnKeys,
      unresolvedRowIds
    ]
  )
  const liveReasoningId = liveLine?.reasoning?.message.id ?? null
  const { slots, responseGroups } = useMemo(
    () =>
      buildNativeChatTranscript({
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
        subagentSections,
        subagentChoices,
        liveReasoningId
      }),
    [
      expandedTurnKeys,
      isWorking,
      lifecycleWorking,
      liveReasoningId,
      liveTurnKey,
      messages,
      openedPullRequests,
      receipts,
      subagentChoices,
      subagentSections,
      turnDiffs,
      turnKeys,
      turnStatuses,
      typography,
      unresolvedRowIds
    ]
  )
  return { slots, responseGroups, liveLine }
}
