import type { ConnectorGitHubUsersResponse } from '../../../../../shared/connector-bot-github-contract'
import type { GitHubPerson } from '../../../../../shared/bots/github-people-rank'
import type { BotWhoCanAskIdentityUpdate } from '../BotWhoCanAskList'

export function supersededGitHubPeople(
  people: readonly GitHubPerson[],
  live: ConnectorGitHubUsersResponse['members']
): { id: string; name: string }[] {
  const liveIds = new Map(live.map(({ id, name }) => [name.toLowerCase(), id]))
  return people
    .filter(({ login, id }) => {
      const current = liveIds.get(login.toLowerCase())
      return current !== undefined && current !== id
    })
    .map(({ id, login }) => ({ id, name: login }))
}

/** What live lookups confirmed during this picker open: current names by id, and ids whose
 *  listed name was given to someone else. A later confirmation of an id clears its doubt. */
export type Identities = {
  names: Readonly<Record<string, string>>
  superseded: ReadonlySet<string>
}
export const NO_IDENTITIES: Identities = { names: {}, superseded: new Set() }

export function learnIdentities(
  known: Identities,
  confirmed: BotWhoCanAskIdentityUpdate
): Identities {
  const superseded = new Set(known.superseded)
  for (const { id, name } of confirmed.superseded) {
    const current = known.names[id]
    if (!current || current.toLowerCase() === name.toLowerCase()) {
      superseded.add(id)
    }
  }
  const names = { ...known.names }
  for (const { id, name } of confirmed.current) {
    names[id] = name
    superseded.delete(id)
  }
  return { names, superseded }
}
