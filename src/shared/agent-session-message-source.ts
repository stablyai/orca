// Who a chat message is from when it is not the person at the composer: another agent, through
// Orca. Carried on the message body (`AgentJournalMessageItem.from`), outside every fingerprint.

import { z } from 'zod'
import { normalizeAgentSessionConversationName } from './agent-session-conversation-name'
import { isOrcaSessionId, type OrcaSessionId } from './orca-session-address'
import type { OrchestrationPartyIdentity } from './orchestration-party-identity'
import { openEnum, salvagedField, salvagedOptional, salvagingArray } from './zod-salvage'

/**
 * An agent a message is from, named by the orchestration database of the host that stores the
 * message: a federated sender arrives as its `dispatch:<id>` address there. No pane key: it reads
 * and consumes that agent's mailbox, so the host resolves it from the address.
 */
export type AgentMessageSender = Readonly<{
  party: Omit<OrchestrationPartyIdentity, 'paneKey'>
  /** What Orca called the sender when it wrote, kept for when it is gone; null when it had none. */
  name: string | null
}>

/** One orchestration message a notice points at: its record, and its sender's `senders` address. */
export type OrchestrationMailMessage = Readonly<{ messageId: string; runId: string; from: string }>

/** "You have N orchestration messages": the pointer a terminal agent is typed, for a mailbox's
 *  unread mail, which the agent reads with `check`. */
export type OrchestrationMailNotice = Readonly<{
  message: 'mail-notice'
  mailbox: string
  dispatchId: string | null
  messages: readonly OrchestrationMailMessage[]
}>

/** A Dispatch's task, sent as the assignee's turn: the records it joins back to while they exist. */
export type OrchestrationTaskMessage = Readonly<{
  message: 'task'
  runId: string
  taskId: string
  dispatchId: string
}>

/** What Orca delivers for other agents, one shape per message kind. */
export type OrchestrationAgentMessage = OrchestrationMailNotice | OrchestrationTaskMessage

export type AgentMessageSource = Readonly<{
  kind: 'agent'
  /** Every distinct sender of the messages it carries, in mail order. */
  senders: readonly AgentMessageSender[]
  /** Null when this build cannot read the kind a newer one wrote; the senders still stand. */
  orchestration: OrchestrationAgentMessage | null
}>

/** Who a send is from, as its submission records it: the kind only (`AgentJournalSubmission.source`),
 *  so a restart or a close keeps only a person's unsent send as a card. The senders stay on the
 *  message body. */
export type AgentSessionMessageSource = Readonly<{ kind: 'user' | 'agent' }>

export const USER_MESSAGE_SOURCE: AgentSessionMessageSource = { kind: 'user' }

export const AGENT_MESSAGE_SOURCE: AgentSessionMessageSource = { kind: 'agent' }

/** A sender name as stored: bounded and flattened like a conversation name, never raw. */
export function agentMessageSenderName(value: unknown): string | null {
  return normalizeAgentSessionConversationName(value)
}

const orcaSessionIdSchema = z.custom<OrcaSessionId>(
  (value) => typeof value === 'string' && isOrcaSessionId(value)
)

const mailNoticeSchema = z.object({
  message: z.literal('mail-notice'),
  mailbox: z.string(),
  dispatchId: z.string().nullable(),
  messages: z.array(z.object({ messageId: z.string(), runId: z.string(), from: z.string() }))
})

const taskSchema = z.object({
  message: z.literal('task'),
  runId: z.string(),
  taskId: z.string(),
  dispatchId: z.string()
})

const senderSchema = z.object({
  party: z.object({
    address: z.string().min(1),
    terminalHandle: z.string().nullable(),
    orcaSessionId: orcaSessionIdSchema.nullable()
  }),
  name: z.unknown().transform(agentMessageSenderName)
})

// Read apart, so a malformed sender or an orchestration kind this build lacks never turns an
// agent's message into the person's.
const sourceSchema = z.object({
  kind: openEnum(['agent'], 'agent'),
  senders: salvagedField('senders', salvagingArray(senderSchema), () => []),
  orchestration: salvagedOptional(
    'orchestration',
    z.discriminatedUnion('message', [mailNoticeSchema, taskSchema])
  ).transform((orchestration) => orchestration ?? null)
})

/** The one reader of a stored or published `from`: undefined (the person's) when it is absent
 *  or not an agent's at all. */
export function readAgentMessageSource(value: unknown): AgentMessageSource | undefined {
  if (value === undefined) {
    return undefined
  }
  const parsed = sourceSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** The senders a label names, and how many more it counts; one notice can carry many. */
export function agentMessageSendersShown(
  source: AgentMessageSource,
  limit = 3
): { shown: readonly AgentMessageSender[]; more: number } {
  return {
    shown: source.senders.slice(0, limit),
    more: Math.max(0, source.senders.length - limit)
  }
}
