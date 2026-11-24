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

/** PUT `${bots}/<bot id>/shares/<share id>/offer`: the accept's answer, sealed to its sealKey. */
export type ConnectorShareOfferRequest = { v: 1; devicePublicKey: string; sealedOffer: string }

/** The share isn't the caller's, or is gone. */
export const UNKNOWN_SHARE_REFUSAL = 'unknown_share'

export function shareOfferPath(botId: string, shareId: string): string {
  return `${CONNECTOR_PATHS.bots}/${encodeURIComponent(botId)}/shares/${encodeURIComponent(shareId)}/offer`
}
