import { useLayoutEffect, useState } from 'react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

type NativeChatTurnTiming = {
  startedAt: number
  workedSeconds: number | null
}

export type NativeChatTurnStatus = {
  startedAt: number | null
  thinking: boolean
  workedSeconds: number | null
}

export function useNativeChatTurnStatus({
  messages,
  latestUserIndex,
  isWorking,
  workingStartedAt
}: {
  messages: readonly NativeChatMessage[]
  latestUserIndex: number
  isWorking: boolean
  workingStartedAt?: number | null
}): {
  active: NativeChatTurnStatus | null
  completedByTurn: Readonly<Record<string, NativeChatTurnStatus>>
} {
  const currentTurnMessages = messages.slice(latestUserIndex + 1)
  const hasCurrentTurnResponse = currentTurnMessages.some(
    (message) =>
      (message.role === 'assistant' || message.role === 'tool') &&
      message.blocks.some(
        (block) =>
          block.type === 'tool-call' ||
          block.type === 'tool-result' ||
          (block.type === 'text' && block.text.trim().length > 0)
      )
  )
  const latestUserId = latestUserIndex !== -1 ? (messages[latestUserIndex]?.id ?? null) : null
  const activeTurnKey = latestUserId ?? '__unanchored__'
  const [timingByTurn, setTimingByTurn] = useState<Record<string, NativeChatTurnTiming>>({})

  useLayoutEffect(() => {
    const validTurnKeys = new Set(
      messages.filter((message) => message.role === 'user').map((message) => message.id)
    )
    validTurnKeys.add(activeTurnKey)
    if (isWorking) {
      setTimingByTurn((current) => {
        let retained = current
        for (const turnKey of Object.keys(current)) {
          if (!validTurnKeys.has(turnKey)) {
            if (retained === current) {
              retained = { ...current }
            }
            delete retained[turnKey]
          }
        }
        const timing = retained[activeTurnKey]
        const startedAt =
          workingStartedAt ??
          (timing?.workedSeconds == null && timing ? timing.startedAt : Date.now())
        if (timing?.startedAt === startedAt && timing.workedSeconds == null) {
          return retained
        }
        const next = { ...retained }
        next[activeTurnKey] = { startedAt, workedSeconds: null }
        return next
      })
      return
    }
    setTimingByTurn((current) => {
      let retained = current
      for (const turnKey of Object.keys(current)) {
        if (!validTurnKeys.has(turnKey)) {
          if (retained === current) {
            retained = { ...current }
          }
          delete retained[turnKey]
        }
      }
      const timing = retained[activeTurnKey]
      if (timing?.workedSeconds != null) {
        return retained
      }
      const startedAt = timing?.startedAt ?? workingStartedAt
      if (startedAt == null) {
        return retained
      }
      return {
        ...retained,
        [activeTurnKey]: {
          startedAt,
          workedSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
        }
      }
    })
  }, [activeTurnKey, isWorking, messages, workingStartedAt])

  const currentTiming = timingByTurn[activeTurnKey]
  const completedByTurn = Object.fromEntries(
    Object.entries(timingByTurn)
      .filter(([, timing]) => timing.workedSeconds != null)
      .map(([turnKey, timing]) => [
        turnKey,
        { startedAt: timing.startedAt, thinking: false, workedSeconds: timing.workedSeconds }
      ])
  )
  return {
    active: isWorking
      ? {
          startedAt: workingStartedAt ?? currentTiming?.startedAt ?? null,
          thinking: !hasCurrentTurnResponse,
          workedSeconds: null
        }
      : (completedByTurn[activeTurnKey] ?? null),
    completedByTurn
  }
}
