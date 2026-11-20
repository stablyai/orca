import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../rpc-param-primitives'

export const PeerMailMessageType = z.enum([
  'status',
  'handoff',
  'question',
  'dispatch',
  'merge_ready'
])

const LINE = z.string().max(500)

/** Who sent peer mail, from the sending Orca's own records; the receiver shows it beside `senderLabel`. */
export const PeerMailSender = z.object({
  name: LINE.nullable(),
  agent: z.string().min(1).max(64).optional(),
  /** The sending Orca's computer name. */
  computer: LINE,
  bot: z.object({ id: LINE, name: LINE, avatar: LINE.nullable() }).optional()
})
export type PeerMailSender = z.infer<typeof PeerMailSender>

/** Agent mail one Orca carries to an agent on a paired Orca, inside a conversation the sender's Orca opened. */
export const PeerMailDeliverParams = z.object({
  conversationId: requiredString('Missing conversation ID'),
  messageId: requiredString('Missing message ID'),
  to: requiredString('Missing --to'),
  senderLabel: requiredString('Missing sender label'),
  subject: requiredString('Missing --subject'),
  body: OptionalString,
  type: PeerMailMessageType.optional(),
  priority: z.enum(['normal', 'high', 'urgent']).optional(),
  threadId: OptionalString,
  /** With a `bot:` address: one of that bot's chats, or `new`; resolved by the receiving Orca. */
  chat: OptionalString,
  /** With a `bot:` address: an item number of that bot's. */
  item: OptionalString,
  /** With `item`: files the sender uploaded to this Orca's attachment store for the item's chat. */
  attachments: z.array(z.string().min(1).max(4096)).max(30).optional(),
  sender: PeerMailSender.optional()
})

/** The opening Orca pulls replies queued for its conversations; waits up to waitMs for one. */
export const PeerMailPullParams = z.object({
  waitMs: OptionalFiniteNumber,
  /** Conversations it could not read and is waiting to retry: their items neither return nor end the wait. */
  holdBack: z.array(z.string()).max(50).optional()
})

export const PeerMailAckParams = z.object({
  acknowledgments: z
    .array(
      z.object({
        conversationId: requiredString('Missing conversation ID'),
        throughSequence: z.number().int().nonnegative()
      })
    )
    .max(50)
})

/** One reply on the wire: the fields the opening Orca stores as mail for its agent. */
export const PeerMailRelayPayload = z.object({
  senderLabel: z.string().min(1),
  /** The replier on the paired Orca, where a reply to this one goes. */
  fromAddress: z.string().min(1),
  subject: z.string(),
  body: z.string(),
  threadId: z.string().nullable(),
  sender: PeerMailSender.optional(),
  /** A bot's answer to a request the opening Orca sent, and what the asker does with it. */
  botAnswer: z.object({ requestId: LINE, view: z.record(z.string(), LINE) }).optional()
})
