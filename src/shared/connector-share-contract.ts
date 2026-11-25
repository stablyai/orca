// Mirror of cloud/packages/connector-contract/src/share-messages.ts for the host of a shared bot.
// Copies, not imports: the CLI compiles src/shared with rootDir src, so it can't reach cloud files.
import * as z from 'zod'
import { BotShareEmailSchema, BotShareIdSchema } from './bots/bot-team-shares'
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

// An invited email signed in to Orca: the host rewrites that invite as this account.
export const ShareResolvedDelivery = z
  .object({
    ...ShareDeliveryFields,
    kind: z.literal('share_resolved'),
    email: BotShareEmailSchema,
    accountId: Id,
    name: Name.optional()
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

// The teammate declined the share: its owner sees so, and a new share id asks them again.
export const ShareDeclinedDelivery = z
  .object({ ...ShareDeliveryFields, kind: z.literal('share_declined'), accountId: Id })
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

/** Every share delivery, as the delivery union lists them. */
export const SHARE_DELIVERIES = [
  ShareResolvedDelivery,
  ShareAcceptDelivery,
  ShareDeclinedDelivery,
  ShareSendDelivery
] as const

/** PUT `${bots}/<bot id>/shares/<share id>/offer`: the accept's answer, sealed to its sealKey. */
export type ConnectorShareOfferRequest = { v: 1; devicePublicKey: string; sealedOffer: string }

/** PUT `${bots}/<bot id>/shares/<share id>/devices/<device id>`: a teammate's phone's share
 *  credential, by hash, before the host gives the phone its grant. DELETE the same path removes it. */
export type ConnectorShareDeviceRequest = { v: 1; credentialHash: string }

export function shareDevicePath(botId: string, shareId: string, deviceId: string): string {
  return `${CONNECTOR_PATHS.bots}/${encodeURIComponent(botId)}/shares/${encodeURIComponent(shareId)}/devices/${encodeURIComponent(deviceId)}`
}

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
      // The agent's purpose line from its owner's hello, when given.
      botPurpose: z.string().min(1).max(1000).optional(),
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

// GET `…/<share id>/messages` (a phone, `Bearer <share credential>`): that share's held states.
export const ConnectorShareHeldSchema = z.object({
  v: z.literal(1),
  held: z
    .array(z.object({ clientMessageId: Id, state: z.enum(SHARE_HELD_STATES) }))
    .max(MAX_SHARE_HELD_STATES)
})
export type ConnectorShareHeld = z.infer<typeof ConnectorShareHeldSchema>

// POST `…/<share id>/decline` ({ v: 1 }): this account turns the share down. Idempotent; the share then
// leaves `mine`, and the owner's host gets share_declined.
export const ConnectorShareDeclineSchema = z.object({ status: z.literal('declined') })

export function sharePath(shareId: string, tail: 'accept' | 'decline' | 'messages'): string {
  return `${CONNECTOR_PATHS.shares}/${encodeURIComponent(shareId)}/${tail}`
}
