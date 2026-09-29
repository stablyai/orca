import { useLayoutEffect, useState } from 'react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  reduceNativeChatTurnTiming,
  selectNativeChatTurnStatuses,
  type NativeChatSettledTurns,
  type NativeChatTurnStatus,
  type NativeChatTurnTimingByTurn
} from '../../../../shared/native-chat-turn-status'

export type { NativeChatTurnStatus }

export function useNativeChatTurnStatus({
  messages,
  activeTurnKey,
  isWorking,
  workingStartedAt,
  settledTurns,
  thinking = false
}: {
  messages: readonly NativeChatMessage[]
  /** The user message whose bar carries the live clock (`selectNativeChatActiveTurnKey`). */
  activeTurnKey: string
  isWorking: boolean
  workingStartedAt?: number | null
  /** Recorded durations (the host's journal or the transcript); they outrank what this client observed. */
  settledTurns?: NativeChatSettledTurns | null
  /** Whether the turn is reasoning right now, derived from its journal content. */
  thinking?: boolean
}): {
  active: NativeChatTurnStatus | null
  completedByTurn: Readonly<Record<string, NativeChatTurnStatus>>
} {
  const [timingByTurn, setTimingByTurn] = useState<NativeChatTurnTimingByTurn>({})

  useLayoutEffect(() => {
    const validTurnKeys = new Set(
      messages.filter((message) => message.role === 'user').map((message) => message.id)
    )
    setTimingByTurn((current) =>
      reduceNativeChatTurnTiming(current, {
        activeTurnKey,
        validTurnKeys,
        isWorking,
        workingStartedAt,
        now: Date.now()
      })
    )
  }, [activeTurnKey, isWorking, messages, workingStartedAt])

  return selectNativeChatTurnStatuses(timingByTurn, {
    activeTurnKey,
    isWorking,
    workingStartedAt,
    thinking,
    settledByTurn: settledTurns ?? undefined
  })
}
