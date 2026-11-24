// Automations deleted from the bot panel stay hidden until the host's next read stops listing them:
// only under the incarnation that deleted them, and for at most a while.
import type { BotActivity } from '../../../../shared/bots/bot-activity-model'
import { botReadAuthorityKey, type BotReadAuthority } from './bot-read-authority'

/** How long a deleted automation stays hidden while its host still lists it. */
export const AUTOMATION_HIDE_TTL_MS = 30_000

export type BotAutomationHide = {
  /** `botReadAuthorityKey` of the incarnation that deleted it. */
  authority: string
  id: string
  name: string
  expiresAt: number
}

const NONE: ReadonlySet<string> = new Set()

/** The ids hidden under the incarnation that answered the current read. */
export function hiddenAutomationIds(
  hides: readonly BotAutomationHide[],
  authority: BotReadAuthority | null
): ReadonlySet<string> {
  if (!authority || hides.length === 0) {
    return NONE
  }
  const key = botReadAuthorityKey(authority)
  const ids = hides.flatMap((hide) => (hide.authority === key ? [hide.id] : []))
  return ids.length > 0 ? new Set(ids) : NONE
}

/**
 * The hides a new read keeps: one under another incarnation, or one its host no longer lists, is done.
 * One the host still lists past its time comes back (`expired`), so its failure can be told once.
 * `listedIds` is the raw read's membership, before any hide.
 */
export function pruneAutomationHides(
  hides: readonly BotAutomationHide[],
  authority: BotReadAuthority,
  listedIds: ReadonlySet<string>,
  now: number
): { kept: readonly BotAutomationHide[]; expired: readonly BotAutomationHide[] } {
  const key = botReadAuthorityKey(authority)
  const kept: BotAutomationHide[] = []
  const expired: BotAutomationHide[] = []
  for (const hide of hides) {
    if (hide.authority !== key || !listedIds.has(hide.id)) {
      continue
    }
    ;(now >= hide.expiresAt ? expired : kept).push(hide)
  }
  return { kept: kept.length === hides.length ? hides : kept, expired }
}

/** When the soonest hide runs out, for the one timer that re-checks them. */
export function nextAutomationHideExpiry(hides: readonly BotAutomationHide[]): number | null {
  return hides.reduce<number | null>(
    (soonest, hide) => (soonest === null || hide.expiresAt < soonest ? hide.expiresAt : soonest),
    null
  )
}

/** The Activity without its hidden automations; the same object when none is hidden. */
export function withoutHiddenAutomations<A extends Pick<BotActivity, 'automations'>>(
  activity: A,
  hidden: ReadonlySet<string>
): A {
  if (hidden.size === 0 || !activity.automations.some((row) => hidden.has(row.automation.id))) {
    return activity
  }
  return {
    ...activity,
    automations: activity.automations.filter((row) => !hidden.has(row.automation.id))
  }
}

/** The Automations card keys (`botUpcomingRows`) of the hidden automations. */
export function hiddenAutomationCardKeys(
  activity: Pick<BotActivity, 'automations'>,
  hidden: ReadonlySet<string>
): ReadonlySet<string> {
  if (hidden.size === 0) {
    return NONE
  }
  const keys = activity.automations.flatMap((row) =>
    hidden.has(row.automation.id) ? [`automation:${row.key}`] : []
  )
  return keys.length > 0 ? new Set(keys) : NONE
}
