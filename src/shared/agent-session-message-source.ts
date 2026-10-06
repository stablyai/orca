// Who a chat message is from: the person at the composer, or another agent through Orca.
// Persisted with a queued card (`queued_messages.source_json`), so the chat can name each sender.

import { z } from 'zod'
import { isOrcaSessionId, type OrcaSessionId } from './orca-session-address'
import type { OrchestrationPartyIdentity } from './orchestration-party-identity'

/**
 * An agent a message is from, named by the orchestration database of the host that stores the
 * message: the only host whose agents can send today. A relayed sender adds its host here. No pane
 * key: it reads and consumes that agent's mailbox, so the host resolves it from the handle.
 */
export type AgentMessageSender = Readonly<{ party: Omit<OrchestrationPartyIdentity, 'paneKey'> }>

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

/** What Orca delivers for other agents, one shape per message kind. */
export type OrchestrationAgentMessage = OrchestrationMailNotice

export type AgentMessageSource = Readonly<{
  kind: 'agent'
  /** Every distinct sender of the messages it carries, in mail order. */
  senders: readonly AgentMessageSender[]
  orchestration: OrchestrationAgentMessage
}>

export type AgentSessionMessageSource = Readonly<{ kind: 'user' }> | AgentMessageSource

export const USER_MESSAGE_SOURCE: AgentSessionMessageSource = { kind: 'user' }

const MESSAGE_SOURCE_VERSION = 1

const orcaSessionIdSchema = z.custom<OrcaSessionId>(
  (value) => typeof value === 'string' && isOrcaSessionId(value)
)

const mailNoticeSchema = z.object({
  message: z.literal('mail-notice'),
  mailbox: z.string(),
  dispatchId: z.string().nullable(),
  messages: z.array(z.object({ messageId: z.string(), runId: z.string(), from: z.string() }))
})

// Not strict: a newer build may add a field, which this one keeps no use for and must not reject.
const storedSourceSchema = z.discriminatedUnion('kind', [
  z.object({ v: z.literal(MESSAGE_SOURCE_VERSION), kind: z.literal('user') }),
  z.object({
    v: z.literal(MESSAGE_SOURCE_VERSION),
    kind: z.literal('agent'),
    senders: z.array(
      z.object({
        party: z.object({
          address: z.string(),
          terminalHandle: z.string().nullable(),
          orcaSessionId: orcaSessionIdSchema.nullable()
        })
      })
    ),
    orchestration: z.discriminatedUnion('message', [mailNoticeSchema])
  })
])

export function serializeAgentSessionMessageSource(source: AgentSessionMessageSource): string {
  return JSON.stringify({ v: MESSAGE_SOURCE_VERSION, ...source })
}

/**
 * The stored value read back. Absent (a card from before the column) is the person's: only the
 * composer queued then. So is a value this build cannot read; either way it is sent as written.
 */
export function readAgentSessionMessageSource(stored: unknown): AgentSessionMessageSource {
  const parsed = storedSourceSchema.safeParse(stored)
  if (!parsed.success) {
    return USER_MESSAGE_SOURCE
  }
  const { v: _version, ...source } = parsed.data
  return source
}
