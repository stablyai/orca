import { useMemo } from 'react'
import {
  nativeChatLiveLine,
  type NativeChatLiveLine
} from '../../../../shared/native-chat/transcript/native-chat-live-line'
import { isNativeChatRowInLiveWorkingTurn } from '../../../../shared/native-chat-turn-membership'
import {
  buildNativeChatTranscriptSlots,
  type NativeChatTranscriptSlot,
  type NativeChatTranscriptSlotsInput
} from './native-chat-transcript-slots'

/** Choose slots/activity together so reasoning shown by the activity line never also gets a transcript row. */
export function useNativeChatTranscriptSlots({
  line,
  ...input
}: Omit<NativeChatTranscriptSlotsInput, 'liveReasoningId'> & {
  line: { draws: boolean; thinking: boolean; stopping?: boolean; activityText?: string | null }
}): { slots: NativeChatTranscriptSlot[]; liveLine: NativeChatLiveLine | null } {
  const {
    messages,
    unresolvedRowIds,
    typography,
    turnKeys,
    liveTurnKey,
    receipts,
    turnStatuses,
    turnDiffs,
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
  const slots = useMemo(
    () =>
      buildNativeChatTranscriptSlots({
        messages,
        unresolvedRowIds,
        typography,
        turnKeys,
        liveTurnKey,
        receipts,
        turnStatuses,
        turnDiffs,
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
  return { slots, liveLine }
}
