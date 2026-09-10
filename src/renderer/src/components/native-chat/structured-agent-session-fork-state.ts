import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import type { AgentSessionConversationCommand } from '../../../../shared/agent-session-conversation-command'

export type StructuredSessionConversationSupport = {
  sessionId: string
  commands: readonly AgentSessionConversationCommand[]
  forkSupported?: boolean
  /** Parent chat this session was forked from; absent on hosts that predate the field. */
  forkedFromSessionId?: string
}

export function structuredSessionForkState(
  state: StructuredAgentSessionState,
  sessionId: string,
  support: StructuredSessionConversationSupport | null
) {
  return {
    forkSupported: support?.sessionId === sessionId && support.forkSupported === true,
    forkedFromSessionId: support?.sessionId === sessionId ? support.forkedFromSessionId : undefined,
    journalItems: state.items,
    forkSource:
      state.fence !== null && state.cursor
        ? { sessionId, expectedRuntimeFence: state.fence, expectedEpoch: state.cursor.epoch }
        : null
  }
}
