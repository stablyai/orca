import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from './rpc-param-primitives'

/** Agent mail one Orca carries to an agent on a paired Orca, inside a conversation the sender's Orca opened. */
export const PeerMailDeliverParams = z.object({
  conversationId: requiredString('Missing conversation ID'),
  messageId: requiredString('Missing message ID'),
  to: requiredString('Missing --to'),
  senderLabel: requiredString('Missing sender label'),
  subject: requiredString('Missing --subject'),
  body: OptionalString,
  type: z.enum(['status', 'handoff']).optional(),
  priority: z.enum(['normal', 'high', 'urgent']).optional(),
  threadId: OptionalString
})

/** The opening Orca pulls replies queued for its conversations; waits up to waitMs for one. */
export const PeerMailPullParams = z.object({
  waitMs: OptionalFiniteNumber
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
  threadId: z.string().nullable()
})
