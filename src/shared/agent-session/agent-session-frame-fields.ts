import type { AgentSessionCurrentRequestsMarker } from './requests/agent-session-current-requests-wire'
import type { AgentSessionQueuePublicationFields } from './requests/agent-session-queued-message-wire'

/** Published-frame host wall clock (epoch ms per AgentSessionHistoryPage) and queuedMessages companions. */
export type AgentSessionFrameFields = {
  commandsChanged?: true
  hostNow?: number
  /** Version of the independent current-request read; absent from older hosts. */
  currentRequests?: AgentSessionCurrentRequestsMarker
} & AgentSessionQueuePublicationFields
