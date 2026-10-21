import { useMemo } from 'react'
import { useAppStore } from '../../store'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatSettledTurns } from '../../../../shared/native-chat-turn-status'
import {
  nativeChatHookLatestTurnWorkedSeconds,
  nativeChatHookTurnStartedAt,
  nativeChatLatestTurnId,
  nativeChatTranscriptSettledTurns
} from './native-chat-terminal-turn'
import { resolveNativeChatHookState } from './use-native-chat-hook-status'

/** The terminal-backed pane's turn timing for the message list: when its running turn began, by
 *  the host, and each finished turn's duration (the host's for the latest, the transcript's for
 *  history). All of it survives a remount of the pane. */
export function useNativeChatTerminalTurnTiming(
  paneKey: string,
  messages: readonly NativeChatMessage[],
  turnActive: boolean
): { workingStartedAt: number | null; settledTurns: NativeChatSettledTurns } {
  // Freshness is time-based: re-read when the scheduler says a silent row aged out.
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)
  void agentStatusEpoch
  const turnStartedAt = useAppStore((s) =>
    nativeChatHookTurnStartedAt(s.agentStatusByPaneKey[paneKey])
  )
  const latestWorkedSeconds = useAppStore((s) => {
    const entry = s.agentStatusByPaneKey[paneKey]
    return nativeChatHookLatestTurnWorkedSeconds(entry, resolveNativeChatHookState(entry) === null)
  })
  const transcriptSettled = useMemo(() => nativeChatTranscriptSettledTurns(messages), [messages])
  const latestTurnId = useMemo(() => nativeChatLatestTurnId(messages), [messages])
  const settledTurns = useMemo(() => {
    if (turnActive || latestWorkedSeconds === undefined || latestTurnId === null) {
      return transcriptSettled
    }
    return new Map(transcriptSettled).set(
      latestTurnId,
      latestWorkedSeconds === null || turnStartedAt === null
        ? null
        : { startedAt: turnStartedAt, workedSeconds: latestWorkedSeconds }
    )
  }, [latestTurnId, latestWorkedSeconds, transcriptSettled, turnActive, turnStartedAt])
  return { workingStartedAt: turnActive ? turnStartedAt : null, settledTurns }
}
