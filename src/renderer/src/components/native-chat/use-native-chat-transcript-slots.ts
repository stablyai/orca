import { useMemo } from 'react'
import {
  nativeChatLiveLine,
  type NativeChatLiveLine
} from '../../../../shared/native-chat-live-line'
import { isNativeChatRowInLiveWorkingTurn } from '../../../../shared/native-chat-turn-membership'
import {
  buildNativeChatTranscriptSlots,
  type NativeChatTranscriptSlot,
  type NativeChatTranscriptSlotsInput
} from './native-chat-transcript-slots'

/** The transcript's slots and its live activity line, decided together: the open reasoning block
 *  the line discloses takes no slot, so a row is hidden exactly while the line shows it. */
export function useNativeChatTranscriptSlots({
  line,
  ...input
}: Omit<NativeChatTranscriptSlotsInput, 'liveReasoningId'> & {
  line: { draws: boolean; thinking: boolean; stopping?: boolean; activityText?: string | null }
}): { slots: NativeChatTranscriptSlot[]; liveLine: NativeChatLiveLine | null } {
  const {
    messages,
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
            isWorking || lifecycleWorking
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
      turnKeys
    ]
  )
  const liveReasoningId = liveLine?.reasoning?.message.id ?? null
  const slots = useMemo(
    () =>
      buildNativeChatTranscriptSlots({
        messages,
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
      typography
    ]
  )
  return { slots, liveLine }
}
