// A teammate's phone reaching an agent shared with them. The phone has no Orca sign-in of its own, so
// the teammate's computer asks the agent's host for a second key, a child of its own, and hands it over
// their existing pairing. The phone then reaches the host over Orca Relay on its own, and holds messages
// in Orca Cloud with a share credential whose hash the host installed there.
import * as z from 'zod'
import { isDevicePublicKeyB64 } from '../remote-runtime/pairing/device-key-proof'
import { BotShareIdSchema } from './bot-team-shares'
import { AgentCardSchema } from './agent-card-contract'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

const Id = lazyZodSchema(() => z.string().min(1).max(128))
const Name = lazyZodSchema(() => z.string().min(1).max(200))
// Canonical padded base64 of 32 bytes: a Curve25519 key the host seals the phone's offer to.
const SealKey = lazyZodSchema(() => z.string().regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/))
// SHA-256 of the phone's share credential, base64url, as the contract's ShareCredentialHashSchema.
export const BotShareCredentialHashSchema = lazyZodSchema(() =>
  z.string().regex(/^[A-Za-z0-9_-]{43}$/)
)

/** The host's method a teammate's computer calls for its phone; refused to a phone's own key. */
export const BOT_SHARE_PROVISION_PHONE_METHOD = 'botShare.provisionPhone'
/** The host's method a teammate's computer calls when its phone is unpaired from it. */
export const BOT_SHARE_REVOKE_PHONE_METHOD = 'botShare.revokePhone'

export const BotShareProvisionPhoneParams = lazyZodSchema(() =>
  z.object({
    // The phone's Ed25519 key: it signs in to Relay and this host, and signs its held messages.
    devicePublicKey: z.string().refine(isDevicePublicKeyB64, 'Invalid device key'),
    sealKey: SealKey,
    credentialHash: BotShareCredentialHashSchema
  })
)
export type BotShareProvisionPhoneParams = z.infer<typeof BotShareProvisionPhoneParams>

/** The phone's share device id on the host, and its relay offer sealed to its seal key. */
export const BotShareProvisionedPhone = lazyZodSchema(() =>
  z.object({ deviceId: Id, sealedOffer: z.string().min(1) })
)
export type BotShareProvisionedPhone = z.infer<typeof BotShareProvisionedPhone>

export const BotShareRevokePhoneParams = lazyZodSchema(() => z.object({ deviceId: Id }))

// The teammate's computer, answering its own phone.

/** Lists the agents shared with this computer's account, for its phone. */
export const SHARED_BOTS_PHONE_LIST_METHOD = 'sharedBots.phone.list'
/** Asks the agent's host for a key for the calling phone, and answers with its grant. */
export const SHARED_BOTS_PHONE_PROVISION_METHOD = 'sharedBots.phone.provision'

export const SharedBotPhoneShare = lazyZodSchema(() =>
  z.object({
    shareId: BotShareIdSchema,
    botId: Id,
    botName: Name,
    ownerName: Name,
    // The computer's id for the agent's host: its pages name the host by it (executionHost runtime:<id>).
    environmentId: Id,
    // The account it is shared with, the computer's own: whose the phone's messages are. Absent from
    // an older computer.
    accountId: Id.optional()
  })
)
export type SharedBotPhoneShare = z.infer<typeof SharedBotPhoneShare>

/** A share offered to the computer's account that waits for Accept or Decline; nothing of it is
 *  paired, so the phone gets no key to it until it is accepted. */
export const SharedBotPhoneRequest = lazyZodSchema(() =>
  z.object({
    shareId: BotShareIdSchema,
    botId: Id,
    botName: Name,
    ownerName: Name,
    botPurpose: z.string().min(1).max(1000).optional(),
    // Its mascot and services; absent from a computer from before cards.
    agentCard: AgentCardSchema
  })
)
export type SharedBotPhoneRequest = z.infer<typeof SharedBotPhoneRequest>

export const SharedBotsPhoneList = lazyZodSchema(() =>
  z.object({
    shares: z.array(SharedBotPhoneShare),
    // Absent from a computer from before Accept.
    requests: z.array(SharedBotPhoneRequest).max(50).optional()
  })
)
export type SharedBotsPhoneList = z.infer<typeof SharedBotsPhoneList>

/** The phone's Accept or Decline of a share offered to its computer's account, which that computer
 *  answers as its own. */
export const SHARED_BOTS_PHONE_ACCEPT_METHOD = 'sharedBots.phone.accept'
export const SHARED_BOTS_PHONE_DECLINE_METHOD = 'sharedBots.phone.decline'
export const SharedBotsPhoneAnswerParams = lazyZodSchema(() =>
  z.object({ shareId: BotShareIdSchema })
)
export const SharedBotsPhoneAnswer = lazyZodSchema(() => z.object({ answered: z.boolean() }))

export const SharedBotsPhoneProvisionParams = lazyZodSchema(() =>
  BotShareProvisionPhoneParams.extend({
    shareId: BotShareIdSchema
  })
)
export type SharedBotsPhoneProvisionParams = z.infer<typeof SharedBotsPhoneProvisionParams>

/**
 * What the phone keeps for one shared agent: the host's offer, sealed to the phone (it names the
 * phone's device id and the host key the relay link pins), the host key the computer pinned for the
 * same host (the phone refuses an offer under any other), and where to hold messages while the host is
 * away.
 */
export const SharedBotPhoneGrant = SharedBotPhoneShare.extend({
  v: lazyZodSchema(() => z.literal(1)),
  connectorOrigin: lazyZodSchema(() => z.string().url().max(2048)),
  hostKey: SealKey,
  sealedOffer: lazyZodSchema(() => z.string().min(1))
})
export type SharedBotPhoneGrant = z.infer<typeof SharedBotPhoneGrant>

/** Why a computer gave its phone no grant: the agent isn't shared with it now, or its host isn't
 *  reachable to ask, or the host or Orca Cloud refused. */
export const SHARED_BOTS_PHONE_ERRORS = {
  unknownShare: 'shared_bot_unknown',
  hostOffline: 'shared_bot_host_offline',
  refused: 'shared_bot_phone_refused'
} as const
