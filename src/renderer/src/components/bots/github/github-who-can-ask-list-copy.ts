// @protected-copy: the setup dialog's picker shows these list sources, dates and limits.
// Who can ask › Add on GitHub: how the people list names what it was read from, when, and where it
// stopped.
import type { Translate } from '@/i18n/use-translate'
import {
  GITHUB_PEOPLE_PER_SOURCE,
  GITHUB_PERSONAL_REPOSITORIES
} from '../../../../../shared/connector-bot-github-contract'

/** When a list was read: the time today, the date otherwise (date and time wouldn't fit one line),
 *  in this computer's own format unless a `locale` is given. */
export function readTime(readAt: number, now: number, locale?: string): string {
  const read = new Date(readAt)
  return new Date(now).toDateString() === read.toDateString()
    ? read.toLocaleTimeString(locale ?? [], { hour: 'numeric', minute: '2-digit' })
    : read.toLocaleDateString(locale ?? [], { month: 'short', day: 'numeric' })
}

export type ListKind = 'repos' | 'orgs' | 'both'

/** The read list's own words, by what it was read from: a repo list, an org list, or (both) a
 *  GitHub list; each key stays a literal for extraction. */
export function listCopy(kind: ListKind, time: string, reader: string, t: Translate) {
  const at = { time }
  const as = { login: reader }
  return kind === 'repos'
    ? {
        from: t('bots.github.whoCanAsk.listFrom', 'Repo list from {{time}}.', at),
        earlier: t(
          'bots.github.whoCanAsk.readEarlier',
          'Repo list from {{time}}. Restart Orca to refresh.',
          at
        ),
        earlierRemote: t(
          'bots.github.whoCanAsk.readEarlierRemote',
          'Repo list from {{time}}. Restart the bot’s Orca.',
          at
        ),
        absent: t('bots.github.whoCanAsk.notInList', 'Not in your repo list'),
        searched: t('bots.github.whoCanAsk.searchedList', 'Searched your repo list.'),
        searchedExact: t(
          'bots.github.whoCanAsk.searchedListExact',
          'Searched your repo list and exact usernames.'
        ),
        historical: t('bots.github.whoCanAsk.fromEarlierList', 'From an earlier repo list'),
        omitted: t('bots.github.whoCanAsk.omitted', 'Not every connected repo was read.'),
        unread: t('bots.github.whoCanAsk.notRead', 'Some repos or members couldn’t be read.'),
        readAs: t('bots.github.whoCanAsk.searchedAs', 'Repos read as @{{login}}.', as)
      }
    : kind === 'orgs'
      ? {
          from: t('bots.github.whoCanAsk.orgListFrom', 'Org list from {{time}}.', at),
          earlier: t(
            'bots.github.whoCanAsk.orgReadEarlier',
            'Org list from {{time}}. Restart Orca to refresh.',
            at
          ),
          earlierRemote: t(
            'bots.github.whoCanAsk.orgReadEarlierRemote',
            'Org list from {{time}}. Restart the bot’s Orca.',
            at
          ),
          absent: t('bots.github.whoCanAsk.notInOrgList', 'Not in your org list'),
          searched: t('bots.github.whoCanAsk.searchedOrgList', 'Searched your org list.'),
          searchedExact: t(
            'bots.github.whoCanAsk.searchedOrgListExact',
            'Searched your org list and exact usernames.'
          ),
          historical: t('bots.github.whoCanAsk.fromEarlierOrgList', 'From an earlier org list'),
          omitted: t('bots.github.whoCanAsk.omittedOrgs', 'Not every connected org was read.'),
          unread: t('bots.github.whoCanAsk.notReadOrgs', 'Some orgs couldn’t be read.'),
          readAs: t('bots.github.whoCanAsk.orgsReadAs', 'Orgs read as @{{login}}.', as)
        }
      : {
          from: t('bots.github.whoCanAsk.gitHubListFrom', 'GitHub list from {{time}}.', at),
          earlier: t(
            'bots.github.whoCanAsk.gitHubReadEarlier',
            'GitHub list from {{time}}. Restart Orca to refresh.',
            at
          ),
          earlierRemote: t(
            'bots.github.whoCanAsk.gitHubReadEarlierRemote',
            'GitHub list from {{time}}. Restart the bot’s Orca.',
            at
          ),
          absent: t('bots.github.whoCanAsk.notInGitHubList', 'Not in your GitHub list'),
          searched: t('bots.github.whoCanAsk.searchedGitHubList', 'Searched your GitHub list.'),
          searchedExact: t(
            'bots.github.whoCanAsk.searchedGitHubListExact',
            'Searched your GitHub list and exact usernames.'
          ),
          historical: t(
            'bots.github.whoCanAsk.fromEarlierGitHubList',
            'From an earlier GitHub list'
          ),
          omitted: t(
            'bots.github.whoCanAsk.omittedBoth',
            'Not every connected repo or org was read.'
          ),
          unread: t('bots.github.whoCanAsk.notReadBoth', 'Some repos or orgs couldn’t be read.'),
          readAs: t('bots.github.whoCanAsk.gitHubReadAs', 'Read from GitHub as @{{login}}.', as)
        }
}

/** Lines for a list not read yet, by what was asked for: repos alone keep repo words; an asked
 *  account may be an org or a person, so anything else says "GitHub list". */
export function requestCopy(reposOnly: boolean, t: Translate) {
  return reposOnly
    ? {
        loading: t('bots.github.whoCanAsk.loading', 'Still loading your repos.'),
        loadingTitle: t('bots.github.whoCanAsk.loadingTitle', 'Still loading your repos'),
        noExactYet: t(
          'bots.github.whoCanAsk.noExactYet',
          'No exact username match. Repos still coming.'
        ),
        loadingTag: t('bots.github.whoCanAsk.reposLoading', 'Repos still loading'),
        uncheckedTag: t('bots.github.whoCanAsk.reposNotChecked', 'Repos not checked'),
        unavailable: t(
          'bots.github.whoCanAsk.unavailable',
          'Couldn’t read repos. Check gh, restart Orca.'
        ),
        unavailableRemote: t(
          'bots.github.whoCanAsk.unavailableRemote',
          'Couldn’t read repos. Check the bot’s computer.'
        ),
        unreached: t('bots.github.whoCanAsk.unreached', 'Couldn’t get the repo list.'),
        noReadable: t('bots.github.whoCanAsk.noReadable', 'No readable repos to search.')
      }
    : {
        loading: t('bots.github.whoCanAsk.loadingList', 'Still loading your GitHub list.'),
        loadingTitle: t('bots.github.whoCanAsk.loadingListTitle', 'Still loading your GitHub list'),
        noExactYet: t(
          'bots.github.whoCanAsk.noExactYetList',
          'No exact username match. List still coming.'
        ),
        loadingTag: t('bots.github.whoCanAsk.listLoading', 'List still loading'),
        uncheckedTag: t('bots.github.whoCanAsk.listNotChecked', 'List not checked'),
        unavailable: t(
          'bots.github.whoCanAsk.unavailableList',
          'Couldn’t read GitHub. Check gh, restart Orca.'
        ),
        unavailableRemote: t(
          'bots.github.whoCanAsk.unavailableListRemote',
          'Couldn’t read GitHub. Check the bot’s computer.'
        ),
        unreached: t('bots.github.whoCanAsk.unreachedList', 'Couldn’t get the GitHub list.'),
        noReadable: t('bots.github.whoCanAsk.noReadableList', 'Nothing readable to search.')
      }
}

/** Why the roster holds only part of its sources' people, by the kind of read that stopped at its
 *  fixed size; typing can't bring those back, so this never advises typing. */
export function cutLine(
  cut: { people: boolean; members: boolean; repositories: boolean },
  t: Translate
): string | null {
  const kinds = [cut.people, cut.members, cut.repositories].filter(Boolean).length
  if (kinds > 1) {
    // Kinds differ (a repo's people, an org's members, a person's repos): say it neutrally.
    return t('bots.github.whoCanAsk.partlyRead', 'Some lists were only partly read.')
  }
  return cut.people
    ? t('bots.github.whoCanAsk.firstPerRepo', 'Showing the first {{count}} people per repo.', {
        count: GITHUB_PEOPLE_PER_SOURCE
      })
    : cut.members
      ? t('bots.github.whoCanAsk.firstPerOrg', 'Showing the first {{count}} members per org.', {
          count: GITHUB_PEOPLE_PER_SOURCE
        })
      : cut.repositories
        ? t('bots.github.whoCanAsk.recentRepos', 'Only your {{count}} latest repos were read.', {
            count: GITHUB_PERSONAL_REPOSITORIES
          })
        : null
}
