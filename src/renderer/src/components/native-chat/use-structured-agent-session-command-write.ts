import { useCallback, useEffect, useRef } from 'react'
import {
  AGENT_SESSION_CONVERSATION_COMMAND_TIMEOUT_MS,
  type AgentSessionConversationCommand,
  type AgentSessionConversationCommandResult
} from '../../../../shared/agent-session-conversation-command'
import type {
  StructuredAgentSessionWrite,
  StructuredAgentSessionWriteOutcome
} from './use-structured-agent-session-mutate'
import { holdStructuredAgentSessionSends } from './structured-agent-session-pending-sends'

/** Holds sends during clear; an older host's replacement keeps the hold until the view leaves. */
export function useStructuredAgentSessionCommandWrite(
  sessionId: string,
  write: StructuredAgentSessionWrite
): (
  command: AgentSessionConversationCommand,
  delivery?: 'queue-if-active'
) => Promise<StructuredAgentSessionWriteOutcome<AgentSessionConversationCommandResult>> {
  // Null once the view left or unmounted, so a reply that lands later releases its hold.
  const shown = useRef<string | null>(sessionId)
  const keptHold = useRef<(() => void) | null>(null)
  useEffect(() => {
    shown.current = sessionId
    return () => {
      shown.current = null
      keptHold.current?.()
      keptHold.current = null
    }
  }, [sessionId])
  return useCallback(
    async (command, delivery) => {
      const send = () =>
        write<AgentSessionConversationCommandResult>(
          'agentSession.conversationCommand',
          'agentSession.conversationCommand',
          { command, ...(delivery ? { delivery } : {}) }
        )
      if (command !== 'clear') {
        return send()
      }
      const release = holdStructuredAgentSessionSends(sessionId)
      setTimeout(release, AGENT_SESSION_CONVERSATION_COMMAND_TIMEOUT_MS)
      let movedOn = false
      try {
        const outcome = await send()
        movedOn = outcome.kind === 'done' && outcome.value.replacementSessionId !== undefined
        return outcome
      } finally {
        if (movedOn && shown.current === sessionId) {
          keptHold.current?.()
          keptHold.current = release
        } else {
          release()
        }
      }
    },
    [sessionId, write]
  )
}
