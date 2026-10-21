import type { AgentSessionCurrentRequestsMarker } from './agent-session-current-requests-wire'
import type { AgentSessionQueuePublicationFields } from './agent-session-queued-message-wire'

/** Every published frame: the host wall clock (ms epoch, see `AgentSessionHistoryPage`), and what
 *  rides beside its `queuedMessages`. */
export type AgentSessionFrameFields = {
  hostNow?: number
  /** Version of the independent current-request read; absent from older hosts. */
  currentRequests?: AgentSessionCurrentRequestsMarker
} & AgentSessionQueuePublicationFields
