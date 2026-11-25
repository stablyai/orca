// Share in the Share dialog: saves every picked person and says who was saved, so the rest stay picked.
import type { BotMember } from '../../../../../shared/bot-types'
import type { TeamShareSuggestion } from './bot-team-share-people'

/** A pick waiting for Share; a Slack or GitHub person keeps the member their connector saves. */
export type StagedPerson = {
  suggestion: TeamShareSuggestion
  connector?: { key: string; member: BotMember }
}

/** Each connector's add, by entry key: whether its people were confirmed and saved. */
export type TeamShareConnectorAdds = Map<string, (members: BotMember[]) => Promise<boolean>>

/**
 * Invites go to the host in one call; each connector then confirms and saves its own people, one
 * confirmation at a time. Answers the keys of those saved; a declined or failed one is left out.
 */
export async function shareStagedPeople(
  staged: readonly StagedPerson[],
  addInvites: (emails: string[]) => Promise<boolean>,
  adds: TeamShareConnectorAdds
): Promise<Set<string>> {
  const saved = new Set<string>()
  const invites = staged.filter(({ suggestion }) => suggestion.kind === 'invite')
  const invited =
    invites.length === 0
      ? Promise.resolve(false)
      : addInvites(
          invites.flatMap(({ suggestion }) =>
            suggestion.kind === 'invite' ? [suggestion.email] : []
          )
        )
  const byConnector = Map.groupBy(
    staged.filter((entry) => entry.connector !== undefined),
    (entry) => entry.connector!.key
  )
  for (const [key, picked] of byConnector) {
    const add = adds.get(key)
    // Never throws, so the dialog's Share always settles.
    const added = add
      ? await add(picked.map((entry) => entry.connector!.member)).catch(() => false)
      : false
    if (added) {
      picked.forEach((entry) => saved.add(entry.suggestion.key))
    }
  }
  if (await invited) {
    invites.forEach((entry) => saved.add(entry.suggestion.key))
  }
  return saved
}
