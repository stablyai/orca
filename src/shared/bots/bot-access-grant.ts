/** Who is about to get access, and the connector they would ask from. */
export type BotAccessGrant = {
  botName: string
  /** identity: who the connector says they are (handle, real name or email), when asked from a request. */
  people: readonly { id: string; name: string; identity?: string }[]
  connector: string
  /** The connector's workspace, when it has one, e.g. a Slack workspace. */
  workspace: string | null
}

/** What the access confirm states before a grant; each side words it. */
export type BotAccessGrantFacts = {
  /** The one person being added; null when several are. */
  person: string | null
  /** The one person's first name, so a long name can't wrap the confirm's title; null when several. */
  firstName: string | null
  /** Everyone being added, by name, in order. */
  names: string[]
  count: number
  /** The one person's connector identity, when known. */
  identity: string | null
}

export function botAccessGrantFacts(grant: BotAccessGrant): BotAccessGrantFacts {
  const one = grant.people.length === 1 ? grant.people[0] : undefined
  return {
    person: one?.name ?? null,
    firstName: one ? firstName(one.name) : null,
    names: grant.people.map((person) => person.name),
    count: grant.people.length,
    identity: one?.identity ?? null
  }
}

/** The first word of a name ("Maximiliana" of "Maximiliana Fernández-Oyelaran"); a one-word name,
 *  handle or name without spaces stays whole. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name
}
