// @protected-copy scope=file
// Why protected: these lines qualify who the setup picker offers for a grant (where a person was
// found, how old that list is, what it doesn't cover), so a language pack must not reword them.
import type { Translate } from '@/i18n/use-translate'
import {
  BOT_GITHUB_OFF,
  type BotGitHubRoster,
  type ConnectorGitHubUsersResponse
} from '../../../../../shared/connector-bot-github-contract'
import type { BotSlackResult } from '../../../../../shared/connector-bot-slack-contract'
import { rankGitHubPeople } from '../../../../../shared/bots/github-people-rank'
import type { GitHubPeopleScope } from '../../../../../shared/bots/github-people-scope'
import { supersededGitHubPeople } from './github-who-can-ask-identities'
import { cutLine, orgSearchCopy } from './github-who-can-ask-copy'
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
  /** The host didn't answer the request (unreachable, or the call failed); Try again asks again. */
  | { status: 'unreached' }

type Answer = {
  roster: GitHubRosterState
  /** The cloud's exact-username lookup; null when the query can't be a username. */
  exact: BotSlackResult<ConnectorGitHubUsersResponse> | null
  query: string
  /** The first linked GitHub login, the key the list is read for. */
  ownerLogin: string | null
  /** Every linked GitHub login (default: ownerLogin); a gh account that is none of them is named. */
  linkedLogins?: readonly string[]
  /** The scope this picker would read now; a reused list read for another is historical. */
  scope: GitHubPeopleScope | undefined
  /** Where the list was read: this computer's Orca, or the bot's computer's. */
  producer: 'local' | 'remote'
  /** The time now (epoch ms), for how old a reused list is. */
  now?: number
}

/** A reused list older than this is worth mentioning on every search. */
export const STALE_LIST_MS = 60 * 60_000

/** When a list was read: the time today, the date otherwise (date and time wouldn't fit one line). */
function readTime(readAt: number, now: number): string {
  const read = new Date(readAt)
  return new Date(now).toDateString() === read.toDateString()
    ? read.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : read.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** One search as the picker draws it. Every line says only what was actually read: an empty list
 *  never reads as "no one exists" when nothing, or not everything, was looked at, and a list read
 *  for another scope or account makes no claim about the current ones. */
export function gitHubWhoCanAskAnswer(
  { roster, exact, query, ownerLogin, linkedLogins, scope, producer, now = Date.now() }: Answer,
  t: Translate
): BotSlackResult<BotWhoCanAskFound> {
  // GitHub off, as the cloud just said, is definitive. With the roster settled and unread too,
  // nothing could look: the error (and its retry) says more than an empty list. A roster still
  // loading may yet answer, so that case waits for it rather than failing now. An unanswered list
  // request is asked again in place, with the failed lookup, by the answer's one Try again.
  const rosterSettledUnread =
    roster.status !== 'read' && roster.status !== 'loading' && roster.status !== 'unreached'
  if (exact && !exact.ok && (exact.error === BOT_GITHUB_OFF || rosterSettledUnread)) {
    return exact
  }
  if (roster.status === 'exact-only') {
    const hint = t('bots.github.whoCanAsk.exactOnly', 'Exact usernames only.')
    return {
      ok: true,
      value: {
        members: exact?.ok ? exact.value.members : [],
        complete: true,
        searchPlaceholder: t('bots.github.whoCanAsk.searchUsername', 'Search by GitHub username'),
        note: hint,
        empty: {
          title: exact?.ok
            ? t('bots.github.whoCanAsk.noPerson', 'No one found for “{{query}}”', { query })
            : t('bots.github.whoCanAsk.couldNotSearch', 'Couldn’t search for “{{query}}”', {
                query
              }),
          detail: hint
        }
      }
    }
  }
  const read = roster.status === 'read' ? roster : null
  const searchedAs = read?.searchedAs
  // A list read for another scope or linked account than this picker's is history: its people
  // are still suggestions, but its sources and absences say nothing about the current ones.
  const historical =
    read !== null &&
    read.reused &&
    (scope === undefined ||
      JSON.stringify(read.readFor.scope) !== JSON.stringify(scope) ||
      read.readFor.owner !== ownerLogin)
  const place =
    read?.from.organizations && read.from.repositories
      ? 'both'
      : read?.from.organizations
        ? 'orgs'
        : 'repos'
  const orgOnly = place === 'orgs'

  // The live lookup is current: a listed person whose login it now gives to someone else is a
  // stale identity (they renamed, another took the name), so the list's entry for them leaves.
  const live = exact?.ok ? exact.value.members : []
  const superseded = new Set(
    read && live.length ? supersededGitHubPeople(read.people, live).map(({ id }) => id) : []
  )
  const ranked = read
    ? rankGitHubPeople(
        read.people.filter((person) => !superseded.has(person.id)),
        query
      )
    : []
  const shown = ranked.slice(0, GITHUB_PEOPLE_SHOWN)
  const listed = new Set(read?.people.map((person) => person.id))
  const cut = read ? read.cut.people || read.cut.members || read.cut.repositories : false
  // Only a whole, uncut, current read of everything connected shows the list doesn't hold someone.
  const whole = read !== null && read.complete && !read.omitted && !cut && !historical
  const uncheckedTag =
    roster.status === 'loading'
      ? t('bots.github.whoCanAsk.reposLoading', 'People list still loading')
      : historical
        ? t('bots.github.whoCanAsk.notInEarlierList', 'Not in the earlier list')
        : read
          ? t('bots.github.whoCanAsk.notAllLoaded', 'Not all people loaded')
          : t('bots.github.whoCanAsk.reposNotChecked', 'People list unavailable')
  const members: BotWhoCanAskFound['members'] = shown.map((person) => ({
    id: person.id,
    name: person.login,
    group: 'scoped' as const,
    ...(person.name && person.name !== person.login ? { handle: person.name } : {})
  }))
  for (const member of live) {
    const row = members.find((shownRow) => shownRow.id === member.id)
    if (row) {
      // Already shown: the live lookup's login is current (the list's may be from before a rename).
      row.name = member.name
    } else if (listed.has(member.id)) {
      // In the list under another login, or past the shown cap: show it, by its current login.
      members.push({ id: member.id, name: member.name, group: 'scoped' as const })
    } else {
      // Only a whole current read shows the list doesn't hold them; otherwise say what's unknown.
      members.push(
        whole
          ? { id: member.id, name: member.name, group: 'outside' as const }
          : { id: member.id, name: member.name, tag: uncheckedTag }
      )
    }
  }

  // Restarting refreshes the list only on the computer that read it.
  const remote = producer === 'remote'
  const rosterLine =
    roster.status === 'loading'
      ? t('bots.github.whoCanAsk.loading', 'People list still loading.')
      : roster.status === 'unavailable' && !roster.spent
        ? // Nothing readable was asked for: no gh ran and nothing was used up.
          t('bots.github.whoCanAsk.noReadable', 'No readable sources for the people list.')
        : roster.status === 'unavailable'
          ? remote
            ? t(
                'bots.github.whoCanAsk.unavailableRemote',
                'Couldn’t read the people list. Check the host.'
              )
            : t(
                'bots.github.whoCanAsk.unavailable',
                'Couldn’t read people. Check gh, restart Orca.'
              )
          : roster.status === 'unreached'
            ? t('bots.github.whoCanAsk.unreached', 'Couldn’t get the people list.')
            : roster.status === 'none'
              ? t('bots.github.whoCanAsk.localNone', 'No connected repos or orgs.')
              : null
  // The unavailable line already explains the missing list, and a third sentence would wrap.
  const exactOnly =
    (roster.status === 'none' || roster.status === 'skipped') && exact?.ok
      ? t('bots.github.whoCanAsk.exactOnly', 'Exact usernames only.')
      : null
  const exactFailed =
    exact && !exact.ok ? t('bots.github.whoCanAsk.exactFailed', 'Username check failed.') : null
  const time = read ? readTime(read.readAt, now) : ''
  const shouldRefresh =
    read?.reused &&
    (historical || now - read.readAt > STALE_LIST_MS || (query.trim() !== '' && shown.length === 0))
  const dated =
    read &&
    (shouldRefresh
      ? remote
        ? t(
            'bots.github.whoCanAsk.readEarlierRemote',
            'People list from {{time}}. Restart the bot’s Orca.',
            { time }
          )
        : t(
            'bots.github.whoCanAsk.readEarlier',
            'People list from {{time}}. Restart Orca to refresh.',
            { time }
          )
      : t('bots.github.whoCanAsk.listFrom', 'People list from {{time}}.', { time }))
  const omitted =
    read?.omitted && !historical
      ? t('bots.github.whoCanAsk.omitted', 'Some connected sources were skipped.')
      : null
  const cutNote = read && !historical ? cutLine(read.cut, t) : null
  const unread =
    read && !read.complete && !historical
      ? orgOnly
        ? t('bots.github.whoCanAsk.orgMembersUnread', 'Some people couldn’t be loaded.')
        : t('bots.github.whoCanAsk.notRead', 'Some repos or members couldn’t be read.')
      : null
  const narrow =
    ranked.length > shown.length
      ? t('bots.github.whoCanAsk.keepTyping', 'Keep typing to narrow.')
      : null
  const reader =
    searchedAs &&
    ownerLogin &&
    !(linkedLogins ?? [ownerLogin]).some(
      (login) => login.toLowerCase() === searchedAs.toLowerCase()
    )
      ? searchedAs
      : null

  const exactSearched = exact?.ok === true
  // An absence refers to the dated list in the note, never to the repos or orgs as they are now.
  const searchedLine =
    !read || historical
      ? null
      : exactSearched
        ? t(
            'bots.github.whoCanAsk.searchedListExact',
            'Searched your people list and exact usernames.'
          )
        : t('bots.github.whoCanAsk.searchedList', 'Searched your people list.')
  const limitation = omitted ?? cutNote ?? unread
  const org = orgOnly
    ? orgSearchCopy(
        {
          reader,
          refresh: Boolean(shouldRefresh),
          remote,
          failure: exactFailed,
          limitation,
          omitted: Boolean(omitted),
          exactSearched,
          searchedLine,
          narrow
        },
        t
      )
    : null
  const note = org
    ? org.note
    : roster.status === 'unreached' && exactFailed
      ? t('bots.github.whoCanAsk.listAndUsernameFailed', 'People list and username check failed.')
      : [
          rosterLine,
          exactOnly,
          dated,
          omitted,
          cutNote,
          unread,
          narrow,
          exactFailed,
          reader &&
            t('bots.github.whoCanAsk.searchedAs', 'People list read as @{{login}}.', {
              login: reader
            })
        ]
          .filter(Boolean)
          .join('\n') || undefined
  // A roster still on its way: nothing definitive yet, whatever the exact lookup said.
  const empty =
    roster.status === 'loading'
      ? {
          title: t('bots.github.whoCanAsk.loadingTitle', 'Still loading people'),
          detail: exactSearched
            ? t('bots.github.whoCanAsk.noExactYet', 'No exact username match. List still loading.')
            : t('bots.github.whoCanAsk.resultsComing', 'Results appear when they load.')
        }
      : !read && !exactSearched
        ? {
            title: t('bots.github.whoCanAsk.couldNotSearch', 'Couldn’t search for “{{query}}”', {
              query
            }),
            // The unavailable line already says what to do; the exact-username hint would wrap it.
            detail:
              (roster.status === 'unavailable' || roster.status === 'unreached') && rosterLine
                ? (note ?? rosterLine)
                : [rosterLine, t('bots.github.whoCanAsk.tryExact', 'Try an exact username.')]
                    .filter(Boolean)
                    .join('\n')
          }
        : {
            title: t('bots.github.whoCanAsk.noPerson', 'No one found for “{{query}}”', { query }),
            detail: org?.empty ?? [searchedLine, note].filter(Boolean).join('\n')
          }

  return {
    ok: true,
    value: {
      members,
      // The note says what was left out, so the picker's generic "not everyone" line stays away.
      complete: true,
      // An absence refers to the dated people list.
      labels: {
        scoped: historical
          ? t('bots.github.whoCanAsk.fromEarlierList', 'From an earlier people list')
          : place === 'both'
            ? t('bots.github.whoCanAsk.reposOrgs', 'Your repos and orgs')
            : place === 'orgs'
              ? t('bots.github.whoCanAsk.orgs', 'Your orgs')
              : t('bots.github.whoCanAsk.repos', 'Your repos'),
        outsideTag: t('bots.github.whoCanAsk.notInList', 'Not in your people list')
      },
      ...(note ? { note } : {}),
      ...(org && limitation ? { noteWithTag: { tag: uncheckedTag, note: org.noteAfterTag } } : {}),
      ...(orgOnly
        ? { snapshot: t('bots.github.whoCanAsk.snapshotDate', 'List from {{time}}', { time }) }
        : {}),
      empty,
      // A failed exact lookup or an unanswered list request can be asked again in place,
      // keeping the query, rows and picks.
      ...((exact && !exact.ok) || roster.status === 'unreached' ? { retryable: true } : {})
    }
  }
}
