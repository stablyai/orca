// Who a bot's conversation acts for, as Orca recorded it when the conversation started: the owner, or
// the people a teammate's request or automation came from. Every check on whom a bot may ask reads it.
import type { ConnectorSource } from '../connectors/external-conversation-link'
import type { ConnectorAskerPlaceKind } from '../connectors/connector-cloud-contract'

/** A person a request is for; `workspaceId` is null when Orca doesn't know which workspace they asked in. */
export type BotRequestPerson = {
  kind: 'person'
  source: ConnectorSource
  userId: string
  name?: string
  workspaceId: string | null
  /** The cloud's verdict for the bot they asked: its owner, or a member the owner added. */
  role: 'owner' | 'member' | null
  /** Where they asked (a channel, a DM, an issue); absent for an automation's event. */
  placeKind?: ConnectorAskerPlaceKind
}

export type BotRequestAsker = { kind: 'owner' } | BotRequestPerson | { kind: 'unknown' }

export const OWNER_ACTS_FOR: readonly BotRequestAsker[] = [{ kind: 'owner' }]

/** Whether every person named is the bots' owner, by Orca's record or the cloud's verdict. */
export function actsForOwner(askers: readonly BotRequestAsker[]): boolean {
  return (
    askers.length > 0 &&
    askers.every(
      (asker) => asker.kind === 'owner' || (asker.kind === 'person' && asker.role === 'owner')
    )
  )
}

/** Whether two records act for the same people: both the owner, or both one same teammate. */
export function sameActsFor(a: readonly BotRequestAsker[], b: readonly BotRequestAsker[]): boolean {
  if (actsForOwner(a) || actsForOwner(b)) {
    return actsForOwner(a) && actsForOwner(b)
  }
  const people = (askers: readonly BotRequestAsker[]) =>
    new Set(
      distinctAskers(askers).flatMap((asker) =>
        asker.kind === 'person' ? [`${asker.source}:${asker.userId}`] : []
      )
    )
  const [mine, theirs] = [people(a), people(b)]
  return mine.size === 1 && theirs.size === 1 && [...mine][0] === [...theirs][0]
}

/** Whom a chat acts for as the cloud keeps it on its thread: its owner, or one teammate; several
 *  people record nothing, which the cloud reads as the owner only. */
export function threadActsFor(
  askers: readonly BotRequestAsker[]
): 'owner' | `member:${string}` | undefined {
  if (actsForOwner(askers)) {
    return 'owner'
  }
  const distinct = distinctAskers(askers)
  const [only] = distinct
  return distinct.length === 1 && only?.kind === 'person' ? `member:${only.userId}` : undefined
}

/** Every asker once, the first kept: a list of people a request is held to, all of them at once. */
export function distinctAskers(askers: readonly BotRequestAsker[]): BotRequestAsker[] {
  const seen = new Set<string>()
  return askers.filter((asker) => {
    const key =
      asker.kind === 'person'
        ? `person:${asker.source}:${asker.userId}:${asker.workspaceId ?? ''}:${asker.role ?? ''}`
        : asker.kind
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

/** What started an automation run, as the host recorded it ("Slack message from Carol in #orca"):
 *  the event's source and kind, who did it and where. Never whom it acts for. */
export type AutomationTriggeredBy = {
  source: string
  event?: string
  actor?: string
  actorId?: string
  place?: string
}
