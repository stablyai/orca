// The Orca accounts and invited emails a bot is shared with (Bot.shares). The host owns the list and
// publishes it in its hello; Orca Cloud mirrors it, resolves invites and relays teammates' accepts.
import * as z from 'zod'
import {
  CONNECTOR_CONNECT_SOURCES,
  type ConnectorConnectSource
} from '../connectors/connector-cloud-paths'

/** One bot's hello lists at most this many, as the connector contract's maxBotShares caps them. */
export const BOT_MAX_SHARES = 50
const MAX_SHARE_EMAIL_LENGTH = 254

/** An email as a share stores and compares it, as the contract's normalizeShareEmail does. */
export function normalizeShareEmail(email: string): string {
  return email.trim().toLowerCase()
}

// URL-safe, as the contract's ShareIdSchema: the id goes in cloud paths.
export const BotShareIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
export const BotShareEmailSchema = z
  .email()
  .max(MAX_SHARE_EMAIL_LENGTH)
  .refine((email) => email === normalizeShareEmail(email))

/** The services a teammate linked to their own Orca account, by name only. A source this Orca doesn't
 *  know (a newer cloud's) is dropped, never the share; the list comes back in one order, once each. */
export const BotShareLinkedSourcesSchema = z
  .array(z.unknown())
  .max(16)
  .transform((sources) => CONNECTOR_CONNECT_SOURCES.filter((source) => sources.includes(source)))

// shareId is minted on Add and kept when the invite resolves, so the cloud's row and a teammate's
// accept name the same share throughout.
export const BotShareSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('account'),
    shareId: BotShareIdSchema,
    accountId: z.string().min(1).max(128),
    name: z.string().min(1).optional(),
    email: BotShareEmailSchema,
    addedAt: z.number(),
    /** Absent from an older cloud's resolve: none shown. */
    linkedSources: BotShareLinkedSourcesSchema.optional()
  }),
  z.object({
    kind: z.literal('invite'),
    shareId: BotShareIdSchema,
    email: BotShareEmailSchema,
    addedAt: z.number(),
    /** When its invite email last went out; absent while none has (its hourly limit, signed out). */
    emailedAt: z.number().optional()
  })
])
export type BotShare = z.infer<typeof BotShareSchema>
export type BotAccountShare = Extract<BotShare, { kind: 'account' }>

/** Read entry by entry, so one a newer Orca wrote (or a bad one) is dropped, never the whole list. */
export const BotSharesSchema = z
  .array(z.unknown())
  .transform((entries) =>
    entries.flatMap((entry) => BotShareSchema.safeParse(entry).data ?? []).slice(0, BOT_MAX_SHARES)
  )

export const BOT_SHARES_FULL = `An agent can be shared with up to ${BOT_MAX_SHARES} people.`

/** The list with an invite for each email not on it yet; throws BOT_SHARES_FULL past the cap. */
export function withBotShareInvites(
  shares: readonly BotShare[],
  emails: readonly string[],
  mint: () => { shareId: string; addedAt: number }
): BotShare[] {
  const next = [...shares]
  for (const email of emails.map(normalizeShareEmail)) {
    if (next.some((share) => share.email === email)) {
      continue
    }
    if (next.length >= BOT_MAX_SHARES) {
      throw new Error(BOT_SHARES_FULL)
    }
    next.push({ kind: 'invite', email, ...mint() })
  }
  return next
}

/** The list with those invites marked emailed at `at`; an entry no longer an invite is left as is. */
export function withBotSharesEmailed(
  shares: readonly BotShare[],
  shareIds: ReadonlySet<string>,
  at: number
): BotShare[] {
  return shares.map((share) =>
    share.kind === 'invite' && shareIds.has(share.shareId) ? { ...share, emailedAt: at } : share
  )
}

/**
 * An invite signed in as an Orca account, applied to the list as the host has it now: null when
 * the share is gone or no longer that email's (removed while the cloud resolved it). An account
 * already on the list keeps its own share, and the invite goes. The same list back: nothing to write.
 */
export function withBotShareResolved(
  shares: readonly BotShare[],
  resolved: {
    shareId: string
    email: string
    accountId: string
    name?: string
    linkedSources?: readonly ConnectorConnectSource[]
  }
): readonly BotShare[] | null {
  const share = shares.find((entry) => entry.shareId === resolved.shareId)
  if (!share || share.email !== normalizeShareEmail(resolved.email)) {
    return null
  }
  if (share.kind === 'account') {
    return share.accountId === resolved.accountId ? shares : null
  }
  if (shares.some((entry) => entry.kind === 'account' && entry.accountId === resolved.accountId)) {
    return shares.filter((entry) => entry.shareId !== share.shareId)
  }
  const account: BotAccountShare = {
    kind: 'account',
    shareId: share.shareId,
    accountId: resolved.accountId,
    ...(resolved.name ? { name: resolved.name } : {}),
    email: share.email,
    addedAt: share.addedAt,
    ...(resolved.linkedSources?.length ? { linkedSources: [...resolved.linkedSources] } : {})
  }
  return shares.map((entry) => (entry === share ? account : entry))
}

/** The share an accept names, while it is still that account's. */
export function botAccountShare(
  shares: readonly BotShare[] | undefined,
  shareId: string,
  accountId: string
): BotAccountShare | null {
  const share = shares?.find((entry) => entry.shareId === shareId)
  return share?.kind === 'account' && share.accountId === accountId ? share : null
}
