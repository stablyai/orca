import * as z from 'zod'
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

export const PeerGroupQuestion = z.object({
  kind: z.literal('question'),
  botId: LINE,
  roomId: LINE,
  rootRequestId: LINE,
  requiresGroupReply: z.literal(true).optional(),
  threadId: LINE.optional()
})

export const PeerGroupMail = z.discriminatedUnion('kind', [
  PeerGroupQuestion,
  z.object({ kind: z.literal('answer'), requestId: LINE })
])

export const GROUP_POST_RELAY_KIND = 'group_post'
export const GROUP_REPLY_RELAY_KIND = 'group_reply'
export const GROUP_ANSWER_CONTEXT_PAYLOAD = '{"groupContinuation":true}'

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
  group: PeerGroupMail.optional(),
  sender: PeerMailSender.optional()
})

/** A paired computer that takes asks from this Orca's agents, named on each of its pulls. Its
 *  pulls in one `session` keep it listening until a pull's caller goes away or it leaves. */
export const PeerMailClientAsksPull = z.object({
  session: z.string().min(1).max(100),
  /** Its persisted host installation id: what `--on-client` and a mention token name it by. */
  installationId: z.string().min(1).max(100),
  name: LINE,
  /** The fingerprint this Orca saw for it under its last pairing, when that pairing was replaced. */
  previousPairing: z.string().min(1).max(200).optional(),
  /** Ends the session now; the pull answers at once. */
  leave: z.boolean().optional()
})

/** The opening Orca pulls replies queued for its conversations; waits up to waitMs for one. */
export const PeerMailPullParams = z.object({
  waitMs: OptionalFiniteNumber,
  /** Conversations it could not read and is waiting to retry: their items neither return nor end the wait. */
  holdBack: z.array(z.string()).max(50).optional(),
  clientAsks: PeerMailClientAsksPull.optional(),
  /** This caller can import follow-up posts and route bot-to-bot answers. */
  groupPosts: z.literal(true).optional()
})

/** One queued item on the wire, pulled from or returned to a paired Orca. */
export const PeerMailItem = z.object({
  conversationId: z.string(),
  sequence: z.number().int().positive(),
  messageId: z.string(),
  kind: z.string().optional(),
  payload: z.string()
})

/** Replies and notices a paired computer owes asks from this Orca's agents, in the pull's item shape. */
export const PeerMailReturnParams = z.object({
  items: z.array(PeerMailItem).max(50)
})

export const PeerMailAckParams = z.object({
  groupPosts: z.literal(true).optional(),
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
  botAnswer: z.object({ requestId: LINE, view: z.record(z.string(), LINE) }).optional(),
  groupPost: z.literal(true).optional(),
  /** A notice that a request the opening Orca sent went unanswered; an older Orca ignores it. */
  notice: z.object({ requestId: LINE }).optional()
})

/** An ask an agent here queued for a paired computer to pull: peer mail it delivers there, plus the
 *  chat the asker acts for, which that computer checks its introductions against. */
export const ClientAskPayload = PeerMailDeliverParams.omit({
  conversationId: true,
  messageId: true,
  attachments: true,
  group: true
}).extend({
  rootSession: z.string().min(1).max(500)
})

/** A reply an agent here sent to mail a paired computer's agent sent it, on the same conversation. */
export const ClientReplyPayload = z.object({
  senderLabel: z.string().min(1),
  /** The agent on that computer it answers. */
  to: z.string().min(1),
  subject: z.string(),
  body: z.string(),
  threadId: z.string().nullable(),
  sender: PeerMailSender.optional()
})
