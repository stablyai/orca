/**
 * P0-2 Agent Message Broker
 *
 * Types and interfaces for point-to-point messaging between registered agent
 * sessions (see src/shared/agent-registry.ts for P0-1, the identity registry
 * this broker builds on). A message is always addressed by keyId — the same
 * identifier an agent uses to register itself in the registry.
 */

/**
 * A single message routed through the broker.
 * Fully formed by the broker itself (messageId/timestamp are never
 * caller-supplied) so every delivered message carries a trustworthy id and
 * send time regardless of which RPC caller constructed the request.
 */
export type AgentMessage = {
  /**
   * Unique identifier for this message, assigned by the broker at send time.
   */
  messageId: string

  /**
   * keyId of the agent that sent this message.
   */
  sourceKeyId: string

  /**
   * keyId of the agent this message is addressed to.
   */
  targetKeyId: string

  /**
   * Caller-supplied message body. Opaque to the broker.
   */
  payload: unknown

  /**
   * Timestamp (milliseconds since epoch) when the broker accepted the send.
   */
  timestamp: number
}

/**
 * Request to send a message through the broker.
 * The broker fills in messageId/timestamp; this is only what a caller must
 * supply.
 */
export type AgentMessageSendRequest = {
  /**
   * keyId of the sending agent.
   */
  sourceKeyId: string

  /**
   * keyId of the agent the message is addressed to.
   */
  targetKeyId: string

  /**
   * Message body. Opaque to the broker.
   */
  payload: unknown
}

/**
 * Outcome of a send attempt.
 *
 * - 'delivered': the target is a live registered agent AND has at least one
 *   active in-process subscriber; the message was handed to every subscriber
 *   synchronously.
 * - 'target-not-found': targetKeyId is not a live entry in the P0-1 agent
 *   registry (never registered, unregistered, or TTL-expired). This is a
 *   routing-identity failure, independent of whether anyone is listening.
 * - 'target-not-subscribed': targetKeyId IS a live registered agent, but the
 *   broker currently has no subscriber for it (its process hasn't attached a
 *   listener, or attached one and has since detached). Distinguished from
 *   'target-not-found' because the caller may reasonably retry — the agent
 *   exists and may subscribe shortly.
 */
export type AgentMessageDeliveryStatus = 'delivered' | 'target-not-found' | 'target-not-subscribed'

/**
 * Result of a broker.send() call.
 */
export type AgentMessageSendResult = {
  /**
   * The delivery outcome.
   */
  status: AgentMessageDeliveryStatus

  /**
   * The fully-formed message the broker attempted to route.
   * Present even on a failed delivery so the caller can log/inspect what was
   * attempted (its messageId is otherwise unobservable on failure).
   */
  message: AgentMessage

  /**
   * Number of subscriber listeners the message was fanned out to.
   * Always 0 unless status === 'delivered'.
   */
  listenerCount: number
}

/**
 * A listener registered for a given target keyId. Invoked synchronously by
 * the broker for every message addressed to that keyId while the
 * subscription is active.
 */
export type AgentMessageListener = (message: AgentMessage) => void

/**
 * Bounds for the message broker, mirroring AGENT_REGISTRY_CONFIG's role for
 * the registry.
 */
export const AGENT_MESSAGE_BROKER_CONFIG = {
  /**
   * Maximum number of concurrent listeners a single keyId may register.
   * Guards against a runaway caller leaking subscriptions.
   */
  MAX_LISTENERS_PER_KEY: 64
} as const
