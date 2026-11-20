import type { Translate } from '@/i18n/use-translate'
import {
  BOT_GITHUB_OFF,
  GITHUB_PEOPLE_PER_SOURCE,
  type BotGitHubRoster,
  type ConnectorGitHubUsersResponse
} from '../../../../../shared/connector-bot-github-contract'
import type { BotSlackResult } from '../../../../../shared/connector-bot-slack-contract'
import { rankGitHubPeople } from '../../../../../shared/bots/github-people-rank'
import type { BotWhoCanAskFound } from '../BotWhoCanAskList'

/** People listed at once; typing narrows the rest. */
export const GITHUB_PEOPLE_SHOWN = 30

/** The roster as the picker knows it: read, still loading, or never asked for (`none`: nothing
 *  connected; `skipped`: the GitHub state isn't known yet). */
export type GitHubRosterState =
  | BotGitHubRoster
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'skipped' }

type Answer = {
  roster: GitHubRosterState
  /** The cloud's exact-username lookup; null when the query can't be a username. */
  exact: BotSlackResult<ConnectorGitHubUsersResponse> | null
  query: string
  /** The linked GitHub login; a different gh account is named. */
  ownerLogin: string | null
  /** Settles when a loading roster arrives, so the picker asks again. */
  pending?: Promise<unknown>
}

/** One search as the picker draws it. Every line says only what was actually read: an empty list
 *  never reads as "no one exists" when nothing, or not everything, was looked at. */
export function gitHubWhoCanAskAnswer(
  { roster, exact, query, ownerLogin, pending }: Answer,
  t: Translate
): BotSlackResult<BotWhoCanAskFound> {
  // GitHub off, as the cloud just said, is definitive; and with no roster either, the error (and
  // its retry) says more than an empty list.
  if (exact && !exact.ok && (exact.error === BOT_GITHUB_OFF || roster.status !== 'read')) {
    return exact
  }
  const read = roster.status === 'read' ? roster : null
  const place =
    read?.from.organizations && read.from.repositories
      ? 'both'
      : read?.from.organizations
        ? 'orgs'
        : 'repos'

  const ranked = read ? rankGitHubPeople(read.people, query) : []
  const shown = ranked.slice(0, GITHUB_PEOPLE_SHOWN)
  const listed = new Set(read?.people.map((person) => person.id))
  const whole = read !== null && read.complete && !read.cut
  const uncheckedTag =
    roster.status === 'loading'
      ? t('bots.github.whoCanAsk.reposLoading', 'Repos still loading')
      : read
        ? t('bots.github.whoCanAsk.notAllLoaded', 'Not all people loaded')
        : t('bots.github.whoCanAsk.reposNotChecked', 'Repos not checked')
  const members: BotWhoCanAskFound['members'] = shown.map((person) => ({
    id: person.id,
    name: person.login,
    group: 'scoped' as const,
    ...(person.name && person.name !== person.login ? { handle: person.name } : {})
  }))
  for (const member of exact?.ok ? exact.value.members : []) {
    if (!listed.has(member.id)) {
      // Only a whole read shows the roster doesn't hold them; otherwise say what's unknown.
      members.push(
        whole
          ? { id: member.id, name: member.name, group: 'outside' as const }
          : { id: member.id, name: member.name, tag: uncheckedTag }
      )
    }
  }

  const rosterLine =
    roster.status === 'loading'
      ? t('bots.github.whoCanAsk.loading', 'Still loading your repos.')
      : roster.status === 'unavailable'
        ? // Which computer goes unsaid: naming a remote one would not fit one line.
          t('bots.github.whoCanAsk.unavailable', 'Couldn’t read repos.')
        : roster.status === 'busy'
          ? t('bots.github.whoCanAsk.busy', 'Repo list is busy. Try again shortly.')
          : roster.status === 'none'
            ? t('bots.github.whoCanAsk.localNone', 'No repos connected.')
            : null
  // Still loading isn't "only": the roster is on its way.
  const exactOnly =
    !read && roster.status !== 'loading' && exact?.ok
      ? t('bots.github.whoCanAsk.exactOnly', 'Exact usernames only.')
      : null
  const limits = [
    read && !read.complete
      ? t('bots.github.whoCanAsk.notRead', 'Some repos or members couldn’t be read.')
      : null,
    read?.cut
      ? t('bots.github.whoCanAsk.firstPerRepo', 'Showing the first {{count}} people per repo.', {
          count: GITHUB_PEOPLE_PER_SOURCE
        })
      : null,
    ranked.length > shown.length
      ? t('bots.github.whoCanAsk.keepTyping', 'Keep typing to narrow.')
      : null,
    exact && !exact.ok
      ? t('bots.github.whoCanAsk.exactFailed', 'Couldn’t check GitHub usernames.')
      : null,
    read?.searchedAs && ownerLogin && read.searchedAs.toLowerCase() !== ownerLogin.toLowerCase()
      ? t('bots.github.whoCanAsk.searchedAs', 'Repos read as @{{login}}.', {
          login: read.searchedAs
        })
      : null
  ]
  const note = [rosterLine, exactOnly, ...limits].filter(Boolean).join(' ') || undefined

  const exactSearched = exact?.ok === true
  const searchedLine = !read
    ? null
    : exactSearched
      ? place === 'both'
        ? t('bots.github.whoCanAsk.searchedBothExact', 'Searched your repos, orgs and usernames.')
        : place === 'orgs'
          ? t('bots.github.whoCanAsk.searchedOrgsExact', 'Searched your orgs and exact usernames.')
          : t('bots.github.whoCanAsk.checkedWhere', 'Searched your repos and exact usernames.')
      : place === 'both'
        ? t('bots.github.whoCanAsk.searchedReposOrgs', 'Searched your repos and orgs.')
        : place === 'orgs'
          ? t('bots.github.whoCanAsk.searchedOrgs', 'Searched your orgs.')
          : t('bots.github.whoCanAsk.searchedRepos', 'Searched your repos.')
  const empty =
    !read && !exactSearched && roster.status !== 'loading'
      ? {
          title: t('bots.github.whoCanAsk.couldNotSearch', 'Couldn’t search for “{{query}}”', {
            query
          }),
          detail: [rosterLine, t('bots.github.whoCanAsk.tryExact', 'Try an exact username.')]
            .filter(Boolean)
            .join(' ')
        }
      : {
          title: t('bots.github.whoCanAsk.noPerson', 'No one found for “{{query}}”', { query }),
          detail: [searchedLine, note].filter(Boolean).join(' ')
        }

  return {
    ok: true,
    value: {
      members,
      // The note says what was left out, so the picker's generic "not everyone" line stays away.
      complete: true,
      labels: {
        scoped:
          place === 'both'
            ? t('bots.github.whoCanAsk.foundInReposAndOrgs', 'Found in your repos and orgs')
            : place === 'orgs'
              ? t('bots.github.whoCanAsk.foundInOrgs', 'Found in your orgs')
              : t('bots.github.whoCanAsk.foundInRepos', 'Found in your repos'),
        outsideTag:
          place === 'both'
            ? t('bots.github.whoCanAsk.notFoundInReposOrOrgs', 'Not found in your repos or orgs')
            : place === 'orgs'
              ? t('bots.github.whoCanAsk.notFoundInOrgs', 'Not found in your orgs')
              : t('bots.github.whoCanAsk.notFoundInRepos', 'Not found in your repos')
      },
      ...(note ? { note } : {}),
      empty,
      ...(pending ? { pending } : {})
    }
  }
}
