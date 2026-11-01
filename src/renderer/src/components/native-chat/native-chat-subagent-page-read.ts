import { useMemo } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatSessionTransport } from './native-chat-session-transport'
import type { NativeChatSubagentPageRead } from './use-native-chat-subagent-page'

export function nativeChatSubagentPageRead(
  transport: NativeChatSessionTransport,
  agent: AgentType,
  sessionId: string | null,
  transcriptPath: string | null | undefined
): NativeChatSubagentPageRead {
  return (subagentId, limit, beforeOffset) => {
    if (!sessionId) {
      return Promise.resolve({ error: 'Transcript unavailable' })
    }
    return transport.readSession(agent, sessionId, limit, transcriptPath ?? undefined, {
      wakeWslDistro: true,
      subagentId,
      ...(beforeOffset === undefined ? {} : { beforeOffset })
    })
  }
}

/** Stable across parent appends so an open child is not reloaded on every live row. */
export function useSubagentPageRead(
  transport: NativeChatSessionTransport,
  agent: AgentType,
  sessionId: string | null,
  transcriptPath: string | null | undefined
): NativeChatSubagentPageRead {
  return useMemo(
    () => nativeChatSubagentPageRead(transport, agent, sessionId, transcriptPath),
    [agent, sessionId, transcriptPath, transport]
  )
}
