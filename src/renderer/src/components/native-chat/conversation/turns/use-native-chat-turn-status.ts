import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionLatestTurn } from '../../../../../../shared/agent-session/agent-session-wire'
import { isStructuredAgentSessionThinking } from '../../../../../../shared/agent-session/view/structured-agent-session-live-turn'
import { nativeChatWorkingPresentation } from '../../../../../../shared/agent-session/view/structured-agent-session-sending'
import type { NativeChatDeliveryNotice } from '../../messages/rows/NativeChatMessageRow'
import { useLayoutEffect, useMemo, useState } from 'react'
import {
  NATIVE_CHAT_UNANCHORED_TURN_KEY,
  reduceNativeChatTurnTiming,
  selectNativeChatTurnStatuses,
  type NativeChatSettledTurns,
  type NativeChatTurnStatus,
  type NativeChatTurnTimingByTurn
} from '../../../../../../shared/native-chat/transcript/turns/native-chat-turn-status'

export function useNativeChatTurnStatus({
  turnKeys,
  liveTurnKey,
  working,
  journalItems,
  latestTurn,
  subagentId,
  notices,
  workingStartedAt,
  settledTurns
}: {
  /** Each row's turn, as `nativeChatTurnMembership` places it. */
  turnKeys: readonly (string | undefined)[]
  /** The live turn, whose bar carries the running clock (`nativeChatTurnMembership`). */
  liveTurnKey: string | undefined
  working: boolean
  journalItems: readonly AgentJournalRenderItem[] | undefined
  latestTurn: AgentSessionLatestTurn | null | undefined
  subagentId: string | null
  notices: ReadonlyMap<string, NativeChatDeliveryNotice> | undefined
  workingStartedAt?: number | null
  /** Recorded durations (the host's journal or the transcript); they outrank what this client observed. */
  settledTurns?: NativeChatSettledTurns | null
}): {
  isWorking: boolean
  turnWorking: boolean
  turnStatuses: {
    active: NativeChatTurnStatus | null
    completedByTurn: Readonly<Record<string, NativeChatTurnStatus>>
  }
} {
  const structured = subagentId === null && journalItems !== undefined
  const thinking = useMemo(
    () =>
      subagentId === null &&
      isStructuredAgentSessionThinking({ items: journalItems ?? [], latestTurn }),
    [journalItems, latestTurn, subagentId]
  )
  const sendPending =
    subagentId === null &&
    !structured &&
    liveTurnKey !== undefined &&
    notices?.get(liveTurnKey)?.sending === true
  const { isWorking, turnWorking } = nativeChatWorkingPresentation(
    working,
    workingStartedAt,
    structured,
    sendPending
  )
  const activeTurnKey = liveTurnKey ?? NATIVE_CHAT_UNANCHORED_TURN_KEY
  const [timingByTurn, setTimingByTurn] = useState<NativeChatTurnTimingByTurn>({})
  const validTurnKeys = useMemo(
    () => new Set(turnKeys.filter((turnKey) => turnKey !== undefined)),
    [turnKeys]
  )

  useLayoutEffect(() => {
    setTimingByTurn((current) =>
      reduceNativeChatTurnTiming(current, {
        activeTurnKey,
        validTurnKeys,
        isWorking,
        workingStartedAt,
        authoritativeStart: structured,
        now: Date.now()
      })
    )
  }, [activeTurnKey, isWorking, structured, validTurnKeys, workingStartedAt])

  const turnStatuses = useMemo(
    () =>
      selectNativeChatTurnStatuses(timingByTurn, {
        activeTurnKey,
        isWorking,
        workingStartedAt,
        authoritativeStart: structured,
        thinking,
        settledByTurn: settledTurns ?? undefined
      }),
    [timingByTurn, activeTurnKey, isWorking, workingStartedAt, thinking, settledTurns, structured]
  )
  return { isWorking, turnWorking, turnStatuses }
}
