import type { StructuredAgentSessionHostCapabilityState } from '../../../../shared/structured-agent-session-host-capability'
import {
  structuredAgentSessionFollowUpsQueue,
  structuredAgentSessionQueueEnabled
} from '../../../../shared/structured-agent-session-queued-cards'

/** What decides, per send, whether it asks the host to hold it as a card. */
export type StructuredAgentSessionQueueDelivery = {
  capability: StructuredAgentSessionHostCapabilityState
  /** The follow-up setting reads Queue. */
  followUpsQueue: boolean
  isWorking: boolean
  stopping: boolean
  session: Parameters<typeof structuredAgentSessionQueueEnabled>[1]
  prompts: Parameters<typeof structuredAgentSessionQueueEnabled>[2]
}

/** The alternate flips the setting first; a waiting command and unanswerable prompts still decide after it. */
export function structuredAgentSessionSendQueues(
  queue: StructuredAgentSessionQueueDelivery,
  alternate?: boolean
): boolean {
  const followUpsQueue = structuredAgentSessionFollowUpsQueue(queue.followUpsQueue, {
    alternate,
    isWorking: queue.isWorking,
    stopping: queue.stopping
  })
  return (
    queue.capability === 'supported' &&
    structuredAgentSessionQueueEnabled(followUpsQueue, queue.session, queue.prompts)
  )
}

export function structuredAgentSessionQueueRequest(
  queue: StructuredAgentSessionQueueDelivery,
  alternate?: boolean
): 'queue-if-active' | undefined {
  return structuredAgentSessionSendQueues(queue, alternate) ? 'queue-if-active' : undefined
}
