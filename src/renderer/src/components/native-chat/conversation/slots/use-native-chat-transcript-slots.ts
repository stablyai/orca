import { NativeChatVisualOwnerContext } from '../../media/visuals/native-chat-visual-owner'
import {
  nativeChatMarkdownImageSources,
  nativeChatVisualMarkdownImageSources
} from '../../markdown/native-chat-markdown-image-sources'
import { useContext, useMemo } from 'react'
import {
  nativeChatLiveLine,
  type NativeChatLiveLine
} from '../../../../../../shared/native-chat/transcript/native-chat-live-line'
import { isNativeChatRowInLiveWorkingTurn } from '../../../../../../shared/native-chat/transcript/native-chat-live-turn-membership'
import {
  buildNativeChatTranscript,
  type NativeChatTranscriptSlot
} from './native-chat-transcript-slots'
import type { NativeChatSideChatForkPoint } from '../../messages/actions/native-chat-side-chat-fork-point'
import type { NativeChatTranscriptSlotsInput } from './native-chat-transcript-input'

/** Choose slots/activity together so reasoning shown by the activity line never also gets a transcript row. */
export function useNativeChatTranscriptSlots({
  line,
  ...input
}: Omit<NativeChatTranscriptSlotsInput, 'liveReasoningId'> & {
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
  const { slots, forkPoint } = useMemo(
    () =>
      buildNativeChatTranscript({
        imageSources,
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
        liveReasoningId,
        forkOffer
      }),
    [
      expandedTurnKeys,
      imageSources,
      forkOffer,
      isWorking,
      lifecycleWorking,
      liveReasoningId,
      liveTurnKey,
      messages,
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
  return { slots, forkPoint, liveLine }
}
