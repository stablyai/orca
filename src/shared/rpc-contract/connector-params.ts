import { z } from 'zod'
import { CONNECTOR_SOURCES } from '../external-conversation-link'
import { AgentLaunchFields } from './agent-launch-params'

const ConnectorDelivery = {
  source: z.enum(CONNECTOR_SOURCES),
  externalId: z.string().min(1, 'Missing external conversation id'),
  /** The caller's id for this delivery; a retry with the same id and payload shares its answer. */
  deliveryId: z.string().min(1, 'Missing delivery id')
}

export const ConnectorStart = z.object({
  ...ConnectorDelivery,
  /** Admitted by the host's connector agent list, so an unsupported one is a refusal, not invalid. */
  agent: z.string().min(1, 'Missing agent'),
  target: AgentLaunchFields.shape.target,
  prompt: z.string().min(1, 'Missing prompt')
})

export const ConnectorSend = z.object({
  ...ConnectorDelivery,
  text: z.string().min(1, 'Missing text')
})

/** Settles the conversation's queued work and stops what its agent is doing. */
export const ConnectorCancel = z.object(ConnectorDelivery)

const ConnectorConversation = {
  source: ConnectorDelivery.source,
  externalId: ConnectorDelivery.externalId
}

export const ConnectorPendingPrompt = z.object(ConnectorConversation)

/** Why `connector.reply` refused; connector_unavailable comes after the host's own retries. */
export const CONNECTOR_REPLY_ERROR_CODES = [
  'not_a_cloud_conversation',
  'no_current_turn',
  'connector_not_connected',
  'not_this_hosts_thread',
  'connector_unavailable'
] as const

// What a reply from a pane with no connector conversation on this machine (SSH, a paired server) answers.
export const CONNECTOR_REPLY_UNAVAILABLE =
  "Replies aren't available from this host yet; the agent's final message is posted to the thread when the turn ends."

/** An agent's reply to its conversation's thread, from the pane it runs in; one replyId posts at most once. */
export const ConnectorReply = z.object({
  paneKey: z.string().min(1, 'Missing pane key'),
  replyId: z.string().min(1, 'Missing reply id'),
  text: z.string().min(1, 'Missing text')
})

export const ConnectorAnswer = z.object({
  ...ConnectorConversation,
  /** The `promptId` the answer is for; any other prompt, or none, refuses. */
  promptId: z.string().min(1, 'Missing prompt id'),
  optionId: z.string().min(1, 'Missing option id')
})

/** Longest a dev watch window may stay open. */
export const CONNECTOR_WATCH_MAX_MS = 10 * 60 * 1000

/** A dev window over the events: the snapshot, then every event until `forMs` passes. */
export const ConnectorWatch = z.object({
  forMs: z.number().int().min(0).max(CONNECTOR_WATCH_MAX_MS)
})
