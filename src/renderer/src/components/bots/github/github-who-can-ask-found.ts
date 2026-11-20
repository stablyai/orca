import type { Translate } from '@/i18n/use-translate'
import type { BotGitHubPeople } from '../../../../../shared/connector-bot-github-contract'
import type { BotWhoCanAskFound } from '../BotWhoCanAskList'

/** The host's answer as the picker draws it: where each person was found, and a note whenever the
 *  search was not the whole story, so an empty or short list never reads as "no one exists". */
export function gitHubWhoCanAskFound(
  people: BotGitHubPeople,
  ownerLogin: string | null,
  t: Translate
): BotWhoCanAskFound {
  const members = people.members.map(({ found, ...member }) => ({
    ...member,
    // An older host says nothing about where someone was found: they stay unlabelled.
    ...(found === 'scope' ? { group: 'scoped' as const } : {}),
    ...(found === 'outside' ? { group: 'outside' as const } : {})
  }))
  const coverage = people.coverage
  if (!coverage) {
    return { members, complete: people.complete }
  }
  const notes: string[] = []
  if (coverage.local === 'unavailable') {
    notes.push(
      t(
        'bots.github.whoCanAsk.localUnavailable',
        'Couldn’t search your repos from this computer, so only exact GitHub usernames were checked.'
      )
    )
  } else if (coverage.local === 'none') {
    notes.push(
      t(
        'bots.github.whoCanAsk.localNone',
        'No repos to search yet, so only exact GitHub usernames were checked.'
      )
    )
  } else if (coverage.local === 'limited') {
    notes.push(
      t(
        'bots.github.whoCanAsk.localLimited',
        'Not every repo or person was searched. Type more of the name to narrow it down.'
      )
    )
  }
  if (coverage.exact === 'failed') {
    notes.push(
      t('bots.github.whoCanAsk.exactFailed', 'Couldn’t check exact GitHub usernames just now.')
    )
  }
  const searchedAs = coverage.searchedAs
  if (searchedAs && ownerLogin && searchedAs.toLowerCase() !== ownerLogin.toLowerCase()) {
    notes.push(
      t(
        'bots.github.whoCanAsk.searchedAs',
        'Your repos were searched as @{{login}}, the GitHub CLI account on this computer.',
        { login: searchedAs }
      )
    )
  }
  return {
    members,
    // The note says what was left out, so the picker's generic "not everyone" line stays away.
    complete: true,
    ...(notes.length > 0 ? { note: notes.join(' ') } : {})
  }
}
