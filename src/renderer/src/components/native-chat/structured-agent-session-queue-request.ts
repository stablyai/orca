import type { StructuredAgentSessionAttachment } from '../../../../shared/structured-agent-session-send-mutation'
import type { StructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'

export type StructuredAgentSessionQueueDelivery = {
  capability: StructuredAgentSessionHostCapabilityState
  enabled: boolean
}

/** Whether a send made now asks to be queued: a host known to queue, with queueing enabled. */
export function structuredAgentSessionNewSendsQueue(
  queue: StructuredAgentSessionQueueDelivery
): boolean {
  return queue.capability === 'supported' && queue.enabled
}

/** Whether the host holds a send as a card while the agent works: only text, which is all its
 *  queue takes. */
export function structuredAgentSessionQueueRequest(
  queue: StructuredAgentSessionQueueDelivery,
  attachments: readonly StructuredAgentSessionAttachment[]
): 'queue-if-active' | undefined {
  return structuredAgentSessionNewSendsQueue(queue) && attachments.length === 0
    ? 'queue-if-active'
    : undefined
}
