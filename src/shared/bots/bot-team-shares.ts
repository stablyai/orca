// The Orca accounts and invited emails a bot is shared with (Bot.shares). The host owns the list and
// publishes it in its hello; Orca Cloud mirrors it, resolves invites and relays teammates' accepts.
import * as z from 'zod'

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
    /** When the teammate accepted it (a device of theirs asked to reach the bot); absent until then. */
    acceptedAt: z.number().optional(),
    /** When the teammate declined it: it stays listed for the owner, as declined, never offered again. */
    declinedAt: z.number().optional()
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
  resolved: { shareId: string; email: string; accountId: string; name?: string }
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
    addedAt: share.addedAt
  }
  return shares.map((entry) => (entry === share ? account : entry))
}

/** A share's teammate answer, as the owner's list and the teammate's computer each keep it. */
export type BotShareAnswered = { declinedAt?: number }

/** Whether a share grants anything. A declined one never does: no access or offer on the owner's host,
 *  no keys or pairing on the teammate's computer. */
export function botShareUsable(share: BotShareAnswered): boolean {
  return share.declinedAt === undefined
}

/** The share an accept names, while it is still that account's and usable. */
export function botAccountShare(
  shares: readonly BotShare[] | undefined,
  shareId: string,
  accountId: string
): BotAccountShare | null {
  const share = shares?.find((entry) => entry.shareId === shareId)
  return share?.kind === 'account' && share.accountId === accountId && botShareUsable(share)
    ? share
    : null
}

export type BotShareAnswer = { shareId: string; accountId: string; answer: 'accepted' | 'declined' }

/** The list with that account's share marked accepted or declined at `at`; the same list once it is
 *  answered, or the share isn't that account's (removed, or shared again under a new id). */
export function withBotShareAnswer(
  shares: readonly BotShare[],
  answer: BotShareAnswer,
  at: number
): readonly BotShare[] {
  const share = botAccountShare(shares, answer.shareId, answer.accountId)
  const field = answer.answer === 'accepted' ? 'acceptedAt' : 'declinedAt'
  // The first answer stands.
  if (!share || share.acceptedAt !== undefined) {
    return shares
  }
  return shares.map((entry) => (entry === share ? { ...share, [field]: at } : entry))
}

/** The list with each account share whose teammate already reaches the bot marked accepted: shares
 *  accepted before the owner's list kept it. */
export function withBotSharesReached(
  shares: readonly BotShare[],
  reachedAccounts: ReadonlySet<string>,
  at: number
): readonly BotShare[] {
  const unmarked = (share: BotShare) =>
    share.kind === 'account' &&
    share.acceptedAt === undefined &&
    share.declinedAt === undefined &&
    reachedAccounts.has(share.accountId)
  return shares.some(unmarked)
    ? shares.map((share) => (unmarked(share) ? { ...share, acceptedAt: at } : share))
    : shares
}

/** A declined share offered again: the same person under a new share id, so the teammate is asked
 *  afresh; the declined id is never offered again. */
export function withBotShareRenewed(
  shares: readonly BotShare[],
  shareId: string,
  mint: () => { shareId: string; addedAt: number }
): readonly BotShare[] {
  return shares.map((share) => {
    if (share.shareId !== shareId || share.kind !== 'account' || share.declinedAt === undefined) {
      return share
    }
    const { acceptedAt: _accepted, declinedAt: _declined, ...rest } = share
    return { ...rest, ...mint() }
  })
}
