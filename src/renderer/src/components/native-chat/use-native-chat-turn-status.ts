import { useLayoutEffect, useMemo, useState } from 'react'
import {
  NATIVE_CHAT_UNANCHORED_TURN_KEY,
  reduceNativeChatTurnTiming,
  selectNativeChatTurnStatuses,
  type NativeChatSettledTurns,
  type NativeChatTurnStatus,
  type NativeChatTurnTimingByTurn
} from '../../../../shared/native-chat-turn-status'

export type { NativeChatTurnStatus }

export function useNativeChatTurnStatus({
  turnKeys,
  liveTurnKey,
  isWorking,
  workingStartedAt,
  settledTurns,
  thinking = false
}: {
  /** Each row's turn, as `nativeChatTurnMembership` places it. */
  turnKeys: readonly (string | undefined)[]
  /** The live turn, whose bar carries the running clock (`nativeChatTurnMembership`). */
  liveTurnKey: string | undefined
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

  return selectNativeChatTurnStatuses(timingByTurn, {
    activeTurnKey,
    isWorking,
    workingStartedAt,
    thinking,
    settledByTurn: settledTurns ?? undefined
  })
}
