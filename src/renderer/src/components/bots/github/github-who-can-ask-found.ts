import type { Translate } from '@/i18n/use-translate'
import type { BotGitHubPeople } from '../../../../../shared/connector-bot-github-contract'
import type { BotWhoCanAskFound } from '../BotWhoCanAskList'

type Context = {
  query: string
  /** The linked GitHub login; a different gh account is named. */
  ownerLogin: string | null
  /** An organization install is in scope, so its members were searched too. */
  withOrganizations: boolean
}

/** The host's answer as the picker draws it. Every line says only what was actually searched:
 *  an empty list never reads as "no one exists" when nothing, or not everything, was looked at. */
export function gitHubWhoCanAskFound(
  people: BotGitHubPeople,
  { query, ownerLogin, withOrganizations }: Context,
  t: Translate
): BotWhoCanAskFound {
  const coverage = people.coverage
  const notFound = t('bots.github.whoCanAsk.noPerson', 'No one found for “{{query}}”', { query })
  // An older host ran only the exact lookup and says nothing about repositories.
  if (!coverage) {
    const tag = t('bots.github.whoCanAsk.reposNotChecked', 'Repos not checked')
    return {
      members: people.members.map(({ found: _found, ...member }) => ({ ...member, tag })),
      complete: people.complete,
      note: t('bots.github.whoCanAsk.exactOnly', 'Exact usernames only.'),
      empty: {
        title: notFound,
        detail: t('bots.github.whoCanAsk.exactOnlyChecked', 'Checked exact usernames only.')
      }
    }
  }
  const searchedScope = coverage.local === 'full' || coverage.local === 'limited'
  // An exact match the scope's search couldn't vouch for either way: never untagged, or it would
  // read as a teammate.
  const uncheckedTag =
    coverage.local === 'limited'
      ? t('bots.github.whoCanAsk.reposPartlyChecked', 'Not all repos checked')
      : t('bots.github.whoCanAsk.reposNotChecked', 'Repos not checked')
  const members = people.members.map(({ found, ...member }) => ({
    ...member,
    ...(found === 'scope' ? { group: 'scoped' as const } : {}),
    ...(found === 'outside' ? { group: 'outside' as const } : {}),
    ...(found === 'exact' ? { tag: uncheckedTag } : {})
  }))

  const scopeLine =
    coverage.local === 'limited'
      ? coverage.narrowable
        ? t('bots.github.whoCanAsk.localLimited', 'Partial results. Keep typing to narrow.')
        : t('bots.github.whoCanAsk.scopeCut', 'Some repos or members weren’t searched.')
      : coverage.local === 'unavailable'
        ? t('bots.github.whoCanAsk.localUnavailable', 'Repos unavailable here.')
        : coverage.local === 'none'
          ? t('bots.github.whoCanAsk.localNone', 'No repos connected.')
          : null
  const exactLine =
    coverage.exact === 'failed'
      ? t('bots.github.whoCanAsk.exactFailed', 'Couldn’t check GitHub usernames.')
      : coverage.exact === 'searched' && !searchedScope
        ? t('bots.github.whoCanAsk.exactOnly', 'Exact usernames only.')
        : null
  const searchedAs = coverage.searchedAs
  const asLine =
    searchedAs && ownerLogin && searchedAs.toLowerCase() !== ownerLogin.toLowerCase()
      ? t('bots.github.whoCanAsk.searchedAs', 'Repos searched as @{{login}} on this computer.', {
          login: searchedAs
        })
      : null
  const note = [scopeLine, exactLine, asLine].filter(Boolean).join(' ') || undefined

  // What an empty result says it looked at.
  const nothingSearched = !searchedScope && coverage.exact !== 'searched'
  const searchedLine =
    coverage.local === 'full'
      ? coverage.exact === 'searched'
        ? t('bots.github.whoCanAsk.checkedWhere', 'Searched your repos and exact usernames.')
        : withOrganizations
          ? t('bots.github.whoCanAsk.searchedReposOrgs', 'Searched your repos and orgs.')
          : t('bots.github.whoCanAsk.searchedRepos', 'Searched your repos.')
      : null
  const empty = nothingSearched
    ? {
        title: t('bots.github.whoCanAsk.couldNotSearch', 'Couldn’t search for “{{query}}”', {
          query
        }),
        detail: [scopeLine, t('bots.github.whoCanAsk.tryExact', 'Try an exact username.')]
          .filter(Boolean)
          .join(' ')
      }
    : { title: notFound, detail: [searchedLine, note].filter(Boolean).join(' ') }

  return {
    members,
    // The note says what was left out, so the picker's generic "not everyone" line stays away.
    complete: true,
    ...(note ? { note } : {}),
    empty
  }
}
