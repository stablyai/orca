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

/** Whether the host holds a send, images included, as a card while the agent works. */
export function structuredAgentSessionQueueRequest(
  queue: StructuredAgentSessionQueueDelivery
): 'queue-if-active' | undefined {
  return structuredAgentSessionNewSendsQueue(queue) ? 'queue-if-active' : undefined
}
