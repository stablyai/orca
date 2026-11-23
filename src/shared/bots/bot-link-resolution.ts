// Where an `orca://bot` link opens across every paired host, for the phone and the desktop alike.

/** What a link needs of a listed bot; each client keeps its own fuller bot. */
export type BotLinkBot = { id: string; name: string; folderWorkspaceId: string }

/**
 * One paired host's answer to "which bots do you have?"; `no-capability` is a host too old to list
 * them, `unreachable` one that never answered in time.
 */
export type BotLinkHostAnswer<B extends BotLinkBot = BotLinkBot, H extends string = string> = {
  hostId: H
  answer:
    | { kind: 'bots'; bots: readonly B[] }
    | { kind: 'no-capability' }
    | { kind: 'unreadable' }
    | { kind: 'unreachable' }
}

export type BotLinkMatch<B extends BotLinkBot = BotLinkBot, H extends string = string> = {
  hostId: H
  bot: B
}

export type BotLinkResolution<B extends BotLinkBot = BotLinkBot, H extends string = string> =
  | { kind: 'open'; match: BotLinkMatch<B, H> }
  // Bot ids are random per host, but any paired host decides what it lists: never guess between two.
  | { kind: 'pick'; matches: BotLinkMatch<B, H>[] }
  | { kind: 'update-needed'; hostIds: H[] }
  | { kind: 'missing' }
  // A silent host may be the one with the bot, so this outranks asking an old host to update.
  | { kind: 'unreachable'; hostIds: H[] }

/** Where `orca://bot/<botId>` opens, from every paired host's answer, in host order. */
export function resolveBotLink<B extends BotLinkBot, H extends string>(
  botId: string,
  answers: readonly BotLinkHostAnswer<B, H>[]
): BotLinkResolution<B, H> {
  const matches = answers.flatMap(({ hostId, answer }) =>
    answer.kind === 'bots'
      ? answer.bots.filter((bot) => bot.id === botId).map((bot) => ({ hostId, bot }))
      : []
  )
  if (matches.length === 1) {
    return { kind: 'open', match: matches[0] }
  }
  if (matches.length > 1) {
    return { kind: 'pick', matches }
  }
  const unreachableHostIds = answers
    .filter(({ answer }) => answer.kind === 'unreachable' || answer.kind === 'unreadable')
    .map(({ hostId }) => hostId)
  if (unreachableHostIds.length > 0) {
    return { kind: 'unreachable', hostIds: unreachableHostIds }
  }
  const oldHostIds = answers
    .filter(({ answer }) => answer.kind === 'no-capability')
    .map(({ hostId }) => hostId)
  return oldHostIds.length > 0
    ? { kind: 'update-needed', hostIds: oldHostIds }
    : { kind: 'missing' }
}

/** A host's answer to redeeming; a desktop's `redeemed` also carries the request it opens. */
export type AccessRequestRedeemOutcome<R extends { botId: string } = { botId: string }> =
  | ({ kind: 'redeemed' } & R)
  // Neither spends the token, so the next host may try: the request's bot is elsewhere, or the cloud refused this account.
  | { kind: 'not-here' }
  | { kind: 'not-owner' }
  | { kind: 'expired' }
  | { kind: 'unsupported' }
  | { kind: 'failed' }

export type AccessRequestRedemption<
  R extends { botId: string } = { botId: string },
  H extends string = string
> =
  | ({ kind: 'redeemed'; hostId: H } & R)
  | Exclude<AccessRequestRedeemOutcome, { kind: 'redeemed' }>

/** Redeems a single-use access-request token one host at a time, stopping at the first that takes it. */
export async function redeemOnFirstHost<R extends { botId: string }, H extends string>(
  hostIds: readonly H[],
  redeem: (hostId: H) => Promise<AccessRequestRedeemOutcome<R>>
): Promise<AccessRequestRedemption<R, H>> {
  const refusals = new Set<AccessRequestRedeemOutcome['kind']>()
  for (const hostId of hostIds) {
    const outcome = await redeem(hostId)
    if (outcome.kind === 'redeemed') {
      return { ...outcome, hostId }
    }
    // Spent or past its time: no other host can take it either.
    if (outcome.kind === 'expired') {
      return outcome
    }
    refusals.add(outcome.kind)
  }
  if (refusals.has('failed')) {
    return { kind: 'failed' }
  }
  if (refusals.has('not-owner')) {
    return { kind: 'not-owner' }
  }
  // Every host that could redeem said the bot isn't there: no paired computer that answered has it.
  return refusals.has('not-here') ? { kind: 'not-here' } : { kind: 'unsupported' }
}

/** A link whose request no answering host has: name the silent hosts, as a bot link does, or say none has it. */
export function resolveAccessRequestNotHere<H extends string>(
  answers: readonly BotLinkHostAnswer<BotLinkBot, H>[]
): Extract<BotLinkResolution<BotLinkBot, H>, { kind: 'unreachable' | 'missing' }> {
  const unreachableHostIds = answers
    .filter(({ answer }) => answer.kind === 'unreachable' || answer.kind === 'unreadable')
    .map(({ hostId }) => hostId)
  return unreachableHostIds.length > 0
    ? { kind: 'unreachable', hostIds: unreachableHostIds }
    : { kind: 'missing' }
}
