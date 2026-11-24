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
  displayedIds,
  queueSendPending,
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
  displayedIds: ReadonlySet<string>
  queueSendPending: boolean
  workingStartedAt?: number | null
  /** Recorded durations (the host's journal or the transcript); they outrank what this client observed. */
  settledTurns?: NativeChatSettledTurns | null
}): {
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
  const sendPending = useMemo(() => {
    if (subagentId !== null) {
      return false
    }
    if (!structured) {
      return liveTurnKey !== undefined && notices?.get(liveTurnKey)?.sending === true
    }
    for (const [id, notice] of notices ?? []) {
      if (notice.sending && displayedIds.has(id)) {
        return true
      }
    }
    return false
  }, [notices, displayedIds, liveTurnKey, structured, subagentId])
  const { isWorking, turnWorking } = nativeChatWorkingPresentation(
    working,
    workingStartedAt,
    structured,
    sendPending || (subagentId === null && queueSendPending)
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
        now: Date.now()
      })
    )
  }, [activeTurnKey, isWorking, validTurnKeys, workingStartedAt])

  // Stable identity keeps status-only renders from rebuilding transcript slots.
  const turnStatuses = useMemo(() => {
    const statuses = selectNativeChatTurnStatuses(timingByTurn, {
      activeTurnKey,
      isWorking,
      workingStartedAt,
      thinking,
      settledByTurn: settledTurns ?? undefined
    })
    return isWorking && !turnWorking ? { ...statuses, active: null } : statuses
  }, [
    timingByTurn,
    activeTurnKey,
    isWorking,
    workingStartedAt,
    thinking,
    settledTurns,
    turnWorking
  ])
  return { turnWorking, turnStatuses }
}
