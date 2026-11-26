// Whether an agent is shared, read from both kinds of sharing: teammates who use it, and its copy link.
import type { BotShare } from '../../../../../shared/bots/bot-team-shares'
import type { BotShareLink } from '../sharing/use-bot-share-link'

export type BotSharingState = {
  /** Teammates with access or invited, by name; a declined one no longer counts. */
  teammates: string[]
  /** Its copy link is live; undefined while that isn't known yet. */
  link: boolean | undefined
}

export function botSharingState(
  shares: readonly BotShare[] | undefined,
  link: BotShareLink | null | undefined
): BotSharingState {
  return {
    teammates: (shares ?? []).flatMap((share) =>
      share.kind === 'account' && share.declinedAt !== undefined
        ? []
        : [share.kind === 'account' ? (share.name ?? share.email) : share.email]
    ),
    link: link === undefined ? undefined : link !== null
  }
}

/** The Sharing row's value: the teammates' names, else On for a live link, else Off; null while unknown. */
export function botSharingValue(
  state: BotSharingState,
  words: { on: string; off: string }
): string | null {
  if (state.teammates.length > 0) {
    return state.teammates.join(', ')
  }
  return state.link === undefined ? null : state.link ? words.on : words.off
}
