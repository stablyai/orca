// Mirror of cloud/packages/connector-contract/src/share-messages.ts for the host of a shared bot.
// Copies, not imports: the CLI compiles src/shared with rootDir src, so it can't reach cloud files.
import * as z from 'zod'
import {
  BotShareEmailSchema,
  BotShareIdSchema,
  BotShareLinkedSourcesSchema
} from './bots/bot-team-shares'
import { CONNECTOR_PATHS } from './connectors/connector-cloud-paths'

const Id = z.string().min(1).max(128)
const Name = z.string().min(1).max(200)
// Canonical padded base64 of 32 bytes (the contract's CANONICAL_KEY_B64).
const PublicKey = z.string().regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/)

/** One person in a bot's hello sharedWith: an Orca account, or an email not yet resolved to one. */
export const ConnectorBotShareSchema = z.union([
  z.object({ shareId: BotShareIdSchema, accountId: Id }),
  z.object({ shareId: BotShareIdSchema, email: BotShareEmailSchema })
])
export type ConnectorBotShare = z.infer<typeof ConnectorBotShareSchema>

// Every share delivery is on the share's own conversation, its ordered queue.
const ShareDeliveryFields = {
  deliveryId: z.string().min(1),
  expiresAt: z.number().int().positive(),
  conversation: z.object({ source: z.literal('orca'), externalId: BotShareIdSchema }),
  shareId: BotShareIdSchema,
  botId: Id
}

// A share delivery's queue is its own share's, so its order holds.
const isOnItsShare = (delivery: { shareId: string; conversation: { externalId: string } }) =>
  delivery.conversation.externalId === delivery.shareId

// An invited email signed in to Orca: the host rewrites that invite as this account, with the
// services that account linked (Share dialog marks). Without email: that account's linked sources
// changed since, for its share already on the host's list.
export const ShareResolvedDelivery = z
  .object({
    ...ShareDeliveryFields,
    kind: z.literal('share_resolved'),
    email: BotShareEmailSchema.optional(),
    accountId: Id,
    name: Name.optional(),
    linkedSources: BotShareLinkedSourcesSchema.optional()
  })
  .refine(isOnItsShare)

// A teammate's device asked to reach the bot: Ed25519 devicePublicKey, Curve25519 sealKey.
export const ShareAcceptDelivery = z
  .object({
    ...ShareDeliveryFields,
    kind: z.literal('share_accept'),
    accountId: Id,
    devicePublicKey: PublicKey,
    sealKey: PublicKey,
    deviceName: Name.optional()
  })
  .refine(isOnItsShare)

// The contract's maxHeldMessageChars: one held message keeps under the cloud's 1 MiB request cap.
/** One held message as the cloud's request holds it: sealed, base64 (contract maxHeldMessageChars). */
export const MAX_HELD_MESSAGE_CHARS = 1024 * 1024 - 4 * 1024

// A teammate's message held while the host was away, sealed to the host's hello hostKey. Only the
// host can open it; the sender it names is checked against the host's own share device rows.
export const ShareSendDelivery = z
  .object({
    ...ShareDeliveryFields,
    kind: z.literal('share_send'),
    accountId: Id,
    clientMessageId: Id,
    sealed: z.string().min(1).max(MAX_HELD_MESSAGE_CHARS)
  })
  .refine(isOnItsShare)

/** PUT `${bots}/<bot id>/shares/<share id>/offer`: the accept's answer, sealed to its sealKey. */
export type ConnectorShareOfferRequest = { v: 1; devicePublicKey: string; sealedOffer: string }

/** The share isn't the caller's, or is gone. */
export const UNKNOWN_SHARE_REFUSAL = 'unknown_share'

export function shareOfferPath(botId: string, shareId: string): string {
  return `${CONNECTOR_PATHS.bots}/${encodeURIComponent(botId)}/shares/${encodeURIComponent(shareId)}/offer`
}

// The teammate's side: GET `${shares}/mine`, POST `…/<share id>/accept` and `…/<share id>/messages`.

const MAX_SHARE_HELD_STATES = 500

export const SHARE_HELD_STATES = ['waiting', 'delivered', 'not_sent'] as const

export const ConnectorSharesMineSchema = z.object({
  v: z.literal(1),
  shares: z.array(
    z.object({
      shareId: BotShareIdSchema,
      botId: Id,
      botName: Name,
      ownerName: Name,
      avatarUrl: z.string().url().max(2048).optional(),
      hostOnline: z.boolean(),
      state: z.enum(['ready', 'needs-accept']),
      // Present only once the host takes held messages; absent, hold nothing.
      hostKey: PublicKey.optional(),
      offers: z
        .array(z.object({ devicePublicKey: PublicKey, sealedOffer: z.string().min(1) }))
        .optional(),
      held: z
        .array(z.object({ clientMessageId: Id, state: z.enum(SHARE_HELD_STATES) }))
        .max(MAX_SHARE_HELD_STATES)
    })
  )
})
export type ConnectorSharesMine = z.infer<typeof ConnectorSharesMineSchema>

export type ConnectorShareAcceptRequest = {
  v: 1
  devicePublicKey: string
  sealKey: string
  deviceName?: string
}
export const ConnectorShareAcceptSchema = z.object({ status: z.literal('queued') })

export type ConnectorShareHoldRequest = { v: 1; clientMessageId: string; sealed: string }
export const ConnectorShareHoldSchema = z.object({ status: z.enum(['held', 'duplicate']) })

export function sharePath(shareId: string, tail: 'accept' | 'messages'): string {
  return `${CONNECTOR_PATHS.shares}/${encodeURIComponent(shareId)}/${tail}`
}
