import { useMemo } from 'react'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import type { structuredChatHistoryPhase } from './native-chat-view-state'

type StructuredChatController = Pick<
  ReturnType<typeof useStructuredAgentSession>,
  | 'messages'
  | 'status'
  | 'isWorking'
  | 'error'
  | 'hasOlder'
  | 'loadingOlder'
  | 'olderHistoryGeneration'
  | 'loadOlder'
>

/** The structured chat as the shared transcript reads it: its rows, and a status that stays
 *  `loading` until the chat's history is known. */
export function useStructuredChatLiveSession(
  controller: StructuredChatController,
  historyPhase: ReturnType<typeof structuredChatHistoryPhase>,
  sessionId: string,
  agent: NativeChatLiveSession['agent'],
  hostReachable: boolean
): NativeChatLiveSession {
  return useMemo<NativeChatLiveSession>(
    () => ({
      messages: controller.messages,
      status:
        controller.status === 'error'
          ? 'error'
          : historyPhase !== 'known'
            ? 'loading'
            : controller.isWorking
              ? 'working'
              : controller.messages.length === 0
                ? 'empty'
                : 'ready',
      sessionId,
      agent,
      ...(controller.error ? { error: controller.error } : {}),
      // Older pages can't load while the host is unreachable, so the row waits for it.
      hasMore: controller.hasOlder && hostReachable,
      loadingEarlier: controller.loadingOlder,
      olderHistoryGeneration: controller.olderHistoryGeneration,
      loadEarlier: controller.loadOlder,
      readPhase:
        controller.status === 'loading'
          ? 'loading'
          : controller.status === 'error'
            ? 'error'
            : 'ready'
    }),
    [controller, historyPhase, agent, sessionId, hostReachable]
  )
}
