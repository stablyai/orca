/**
 * What an agent's message does when the chat it reaches is mid-turn: wait as a queued card
 * (`queue`), or join the running turn (`steer`). Idle chats and terminal agents take it the same
 * way either way.
 */

export const ORCHESTRATION_BUSY_DELIVERIES = ['queue', 'steer'] as const

export type OrchestrationBusyDelivery = (typeof ORCHESTRATION_BUSY_DELIVERIES)[number]

export const INVALID_ORCHESTRATION_BUSY_DELIVERY_MESSAGE =
  'Invalid --delivery. Expected one of: queue, steer.'

/** A beat that steered would interrupt the coordinator's turn on every beat. */
export const HEARTBEAT_STEER_REFUSAL_MESSAGE = 'A heartbeat cannot use --delivery steer.'

/** Without --inject a dispatch sends the assignee nothing, so a delivery would silently do nothing. */
export const DISPATCH_DELIVERY_WITHOUT_INJECT_MESSAGE =
  '--delivery applies only with --inject; without it the task is not sent to the assignee.'

export function isOrchestrationBusyDelivery(value: unknown): value is OrchestrationBusyDelivery {
  return value === 'queue' || value === 'steer'
}

/** Lenient on purpose: a stored row may hold a value a newer build wrote, and that waits. */
export function readOrchestrationBusyDelivery(value: unknown): OrchestrationBusyDelivery {
  return value === 'steer' ? 'steer' : 'queue'
}

/** The one mapping onto `sendAgentTurn`'s delivery: `now` is the composer's plain send. */
export function agentTurnDeliveryFor(delivery: OrchestrationBusyDelivery): 'queue' | 'now' {
  return delivery === 'steer' ? 'now' : 'queue'
}
