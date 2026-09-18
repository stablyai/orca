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
  latestUserIndex,
  isWorking,
  workingStartedAt,
  settledTurns,
  thinking = false
}: {
  messages: readonly NativeChatMessage[]
  latestUserIndex: number
  isWorking: boolean
  workingStartedAt?: number | null
  /** Host-recorded durations; they outrank whatever this client observed. */
  settledTurns?: NativeChatSettledTurns | null
  /** Whether the turn is reasoning right now, derived from its journal content. */
  thinking?: boolean
}): {
  active: NativeChatTurnStatus | null
  completedByTurn: Readonly<Record<string, NativeChatTurnStatus>>
} {
  const latestUserId = latestUserIndex !== -1 ? (messages[latestUserIndex]?.id ?? null) : null
  const activeTurnKey = latestUserId ?? '__unanchored__'
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
