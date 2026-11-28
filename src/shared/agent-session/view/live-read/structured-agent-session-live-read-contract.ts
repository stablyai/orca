import type { AgentJournalCursor } from '../../journal/agent-session-journal-identity'
import type { AgentSessionSubscribeEvent } from '../../agent-session-wire'
import type { AgentSessionTextAppendCapabilities } from './agent-session-text-append'
import type { AgentSessionRefusalReference } from '../../failures/agent-session-wire-refusals'
import type { AgentSessionCurrentRequestsPiece, AgentSessionCurrentRequestsRead } from '../../requests/agent-session-current-requests-wire'
import type { StructuredAgentSessionAction } from './structured-agent-session-reducer'
import type { StructuredAgentSessionCoalescing } from './structured-agent-session-coalescer'
import type {
  createStructuredAgentSessionSubscribeAsks,
  StructuredAgentSessionSubscribeCapabilities
} from './structured-agent-session-subscribe-asks'

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

/** Resume from the last applied cursor after stream end/failure with capped exponential backoff. */
export type StructuredAgentSessionLiveReadInput = {
  applyRequests?: (action: StructuredAgentSessionAction) => void
  applyEvent: (event: AgentSessionSubscribeEvent, options?: { opensSubscription: true }) => void
  /** `message` is the failure's own text, for logs; `refusal` is what a surface words. */
  applyError: (message: string, refusal?: AgentSessionRefusalReference) => void
  getCursor: () => AgentJournalCursor | null
  /** Mark retained content stale until reconnect delivers. */
  onContactLost: () => void
  onHistoryReadInvalidated: () => void
  hydrate?: (shouldStop: () => boolean) => Promise<void>
  sessionId: string
  subscribe: StructuredAgentSessionLiveSubscribe
  /** How streamed text batches merge, and whether a hidden viewer holds them; defaults apply. */
  coalesce?: StructuredAgentSessionCoalescing
  /** The appends the host advertises; opens wait for it, and null or a rejection means none. */
  textAppend?:
    | Promise<AgentSessionTextAppendCapabilities | null>
    | AgentSessionTextAppendCapabilities
  /** Whether this reader shows prompt suggestions and the host takes the param; a rejection means no. */
  promptSuggestions?: Promise<boolean> | boolean
  providerReceived?: boolean
  liveTextViewer?: Parameters<typeof createStructuredAgentSessionSubscribeAsks>[0]['liveTextViewer']
  readCurrentRequests: (
    request: AgentSessionCurrentRequestsRead
  ) => Promise<AgentSessionCurrentRequestsPiece>
  /** Calls `retryNow` when the host is likely reachable again; returns what stops listening. */
  subscribeRetryNow: (retryNow: () => void) => () => void
}
