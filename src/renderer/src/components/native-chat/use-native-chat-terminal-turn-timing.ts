import { useMemo } from 'react'
import { useAppStore } from '../../store'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatSettledTurns } from '../../../../shared/native-chat-turn-status'
import {
  nativeChatHookLatestTurnWorkedSeconds,
  nativeChatHookTurnStartedAt,
  nativeChatLatestTurnId,
  nativeChatTerminalSettledTurns,
  nativeChatTranscriptSettledTurns
} from '../../../../shared/native-chat/native-chat-terminal-turn'
import { resolveNativeChatHookState } from '../../../../shared/native-chat/native-chat-live-status'

/** Keep host live/latest-turn timing and historical transcript durations across pane remounts. */
export function useNativeChatTerminalTurnTiming(
  paneKey: string,
  messages: readonly NativeChatMessage[],
  turnActive: boolean
): { workingStartedAt: number | null; settledTurns: NativeChatSettledTurns } {
  const turnStartedAt = useAppStore((s) =>
    nativeChatHookTurnStartedAt(s.agentStatusByPaneKey[paneKey])
  )
  const latestWorkedSeconds = useAppStore((s) => {
    const entry = s.agentStatusByPaneKey[paneKey]
    return nativeChatHookLatestTurnWorkedSeconds(entry, resolveNativeChatHookState(entry) === null)
  })
  const transcriptSettled = useMemo(() => nativeChatTranscriptSettledTurns(messages), [messages])
  const latestTurnId = useMemo(() => nativeChatLatestTurnId(messages), [messages])
  const settledTurns = useMemo(
    () =>
      nativeChatTerminalSettledTurns({
        transcriptSettled,
        latestTurnId,
        latestWorkedSeconds,
        turnStartedAt,
        turnActive
      }),
    [latestTurnId, latestWorkedSeconds, transcriptSettled, turnActive, turnStartedAt]
  )
  return { workingStartedAt: turnActive ? turnStartedAt : null, settledTurns }
}
