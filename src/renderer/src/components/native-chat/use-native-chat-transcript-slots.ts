import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toggleNativeChatExpandedKey } from './native-chat-expanded-keys'
import {
  nativeChatHistoryTurnFold,
  nativeChatTurnFoldRow,
  type NativeChatTurnFoldHistory
} from '../../../../shared/native-chat/transcript/native-chat-turn-fold'
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
  scopeKey,
  historyHead,
  ...input
}: Omit<NativeChatTranscriptSlotsInput, 'liveReasoningId' | 'expandedTurnKeys' | 'turnFold'> & {
  scopeKey: string
  historyHead?: string
  line: { draws: boolean; thinking: boolean; stopping?: boolean; activityText?: string | null }
}): {
  slots: NativeChatTranscriptSlot[]
  liveLine: NativeChatLiveLine | null
  expandedTurnKeys: ReadonlySet<string>
  toggleExpandedTurn: (key: string) => void
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
    isWorking,
    lifecycleWorking,
    subagentSections,
    subagentChoices
  } = input
  const [expandedTurnKeys, setExpandedTurnKeys] = useState<ReadonlySet<string>>(new Set())
  const committedFold = useRef<NativeChatTurnFoldHistory | null>(null)
  const historyFold = useMemo(
    () =>
      nativeChatHistoryTurnFold(committedFold.current, {
        scope: scopeKey,
        historyHead,
        messages,
        rows: messages.map((message, index) =>
          nativeChatTurnFoldRow(message, turnKeys[index], receipts.has(message.id))
        ),
        settledTurnKeys: new Set(
          Object.entries(turnStatuses.completedByTurn).flatMap(([key, status]) =>
            status.workedSeconds != null ? [key] : []
          )
        ),
        expandedTurnKeys
      }),
    [scopeKey, historyHead, messages, turnKeys, receipts, turnStatuses, expandedTurnKeys]
  )
  useLayoutEffect(() => {
    committedFold.current = historyFold
  }, [historyFold])
  const toggleExpandedTurn = useCallback(
    (key: string) => {
      setExpandedTurnKeys(toggleNativeChatExpandedKey(historyFold.expandedTurnKeys, key))
    },
    [historyFold.expandedTurnKeys]
  )
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
        expandedTurnKeys: historyFold.expandedTurnKeys,
        turnFold: historyFold,
        isWorking,
        lifecycleWorking,
        subagentSections,
        subagentChoices,
        liveReasoningId
      }),
    [
      historyFold,
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
  return { slots, liveLine, expandedTurnKeys: historyFold.expandedTurnKeys, toggleExpandedTurn }
}
