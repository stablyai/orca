import type { AgentJournalCursor } from '../../journal/agent-session-journal-identity'
import type { AgentSessionSubscribeEvent } from '../../agent-session-wire'
import type { StructuredAgentSessionSubscribeCapabilities } from './structured-agent-session-subscribe-asks'

/** One `agentSession.subscribe` stream, opened by whichever transport the client has. */
export type StructuredAgentSessionLiveSubscribe = (
  params: {
    sessionId: string
    cursor?: AgentJournalCursor
    capabilities?: StructuredAgentSessionSubscribeCapabilities
  },
  onEvent: (event: AgentSessionSubscribeEvent) => void,
  onError: (error: unknown) => void,
  onClose: () => void
) => Promise<{ unsubscribe: () => void }>
