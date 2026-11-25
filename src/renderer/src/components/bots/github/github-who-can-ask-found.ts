// @protected-copy: the setup dialog's picker shows these list sources, dates and absences.
import type { Translate } from '@/i18n/use-translate'
import {
  BOT_GITHUB_OFF,
  type BotGitHubRoster,
  type ConnectorGitHubUsersResponse
} from '../../../../../shared/connector-bot-github-contract'
import type { BotSlackResult } from '../../../../../shared/connector-bot-slack-contract'
import { rankGitHubPeople } from '../../../../../shared/bots/github-people-rank'
import type { GitHubPeopleScope } from '../../../../../shared/bots/github-people-scope'
import type { BotWhoCanAskFound } from '../BotWhoCanAskList'
import { cutLine, listCopy, readTime, type ListKind } from './github-who-can-ask-list-copy'

/** People listed at once; typing narrows the rest. */
export const GITHUB_PEOPLE_SHOWN = 30

/** The roster as the picker knows it: read, still loading, or never asked for (`none`: nothing
 *  connected; `skipped`: the GitHub state isn't known yet). */
export type GitHubRosterState =
  | BotGitHubRoster
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'skipped' }
  /** The host didn't answer the request (unreachable, or the call failed); a new open asks again. */
  | { status: 'unreached' }

type Answer = {
  roster: GitHubRosterState
  /** The cloud's exact-username lookup; null when the query can't be a username, `pending` while
   *  it is still on its way (the list's rows go out meanwhile). */
  exact: BotSlackResult<ConnectorGitHubUsersResponse> | 'pending' | null
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

/** One search as the picker draws it. Every line says only what was actually read: an empty list
 *  never reads as "no one exists" when nothing, or not everything, was looked at, and a list read
 *  for another scope or account makes no claim about the current ones. */
export function gitHubWhoCanAskAnswer(
  { roster, exact, query, ownerLogin, linkedLogins, scope, producer, now = Date.now() }: Answer,
  t: Translate
): BotSlackResult<BotWhoCanAskFound> {
  // GitHub off, as the cloud just said, is definitive. With the roster settled and unread too,
  // nothing could look: the error (and its retry) says more than an empty list. A roster still
  // loading may yet answer, so that case waits for it rather than failing now.
  const rosterSettledUnread = roster.status !== 'read' && roster.status !== 'loading'
  if (
    exact &&
    exact !== 'pending' &&
    !exact.ok &&
    (exact.error === BOT_GITHUB_OFF || rosterSettledUnread)
  ) {
    return exact
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
  const place: ListKind =
    read?.from.organizations && read.from.repositories
      ? 'both'
      : read?.from.organizations
        ? 'orgs'
        : 'repos'
  const list = listCopy(place, read ? readTime(read.readAt, now) : '', t)
  const settledExact = exact === 'pending' ? null : exact

  const ranked = read ? rankGitHubPeople(read.people, query) : []
  const shown = ranked.slice(0, GITHUB_PEOPLE_SHOWN)
  const listed = new Set(read?.people.map((person) => person.id))
  const cut = read ? read.cut.people || read.cut.members || read.cut.repositories : false
  // Only a whole, uncut, current read of everything connected shows the list doesn't hold someone.
  const whole = read !== null && read.complete && !read.omitted && !cut && !historical
  const uncheckedTag =
    roster.status === 'loading'
      ? t('bots.github.whoCanAsk.reposLoading', 'Repos still loading')
      : historical
        ? t('bots.github.whoCanAsk.notInEarlierList', 'Not in the earlier list')
        : read
          ? t('bots.github.whoCanAsk.notAllLoaded', 'Not all people loaded')
          : t('bots.github.whoCanAsk.reposNotChecked', 'Repos not checked')
  const live = settledExact?.ok ? settledExact.value.members : []
  // The live lookup owns each login it returns: a list entry with that login under another id
  // is a renamed account the list hasn't caught up with, so it is neither shown nor kept picked.
  const retired = (read?.people ?? [])
    .filter((person) =>
      live.some(
        (member) =>
          member.id !== person.id && member.name.toLowerCase() === person.login.toLowerCase()
      )
    )
    .map((person) => person.id)
  const members: BotWhoCanAskFound['members'] = shown
    .filter((person) => !retired.includes(person.id))
    .map((person) => ({
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
      row.live = true
    } else if (listed.has(member.id)) {
      // In the list under another login, or past the shown cap: show it, by its current login.
      members.push({ id: member.id, name: member.name, group: 'scoped' as const, live: true })
    } else {
      // Only a whole current read shows the list doesn't hold them; otherwise say what's unknown.
      members.push(
        whole
          ? { id: member.id, name: member.name, group: 'outside' as const, live: true }
          : { id: member.id, name: member.name, tag: uncheckedTag, live: true }
      )
    }
  }

  // Restarting refreshes the list only on the computer that read it.
  const remote = producer === 'remote'
  const rosterLine =
    roster.status === 'loading'
      ? t('bots.github.whoCanAsk.loading', 'Still loading your repos.')
      : roster.status === 'unavailable' && !roster.spent
        ? // Nothing readable was asked for: no gh ran and nothing was used up.
          t('bots.github.whoCanAsk.noReadable', 'No readable repos to search.')
        : roster.status === 'unavailable'
          ? remote
            ? t(
                'bots.github.whoCanAsk.unavailableRemote',
                'Couldn’t read repos. Check the bot’s computer.'
              )
            : t('bots.github.whoCanAsk.unavailable', 'Couldn’t read repos. Check gh, restart Orca.')
          : roster.status === 'unreached'
            ? t('bots.github.whoCanAsk.unreached', 'Couldn’t get the repo list.')
            : roster.status === 'none'
              ? t('bots.github.whoCanAsk.localNone', 'No repos connected.')
              : null
  // The unavailable line already explains the missing list, and a third sentence would wrap.
  const exactOnly =
    (roster.status === 'none' || roster.status === 'skipped') && settledExact?.ok
      ? t('bots.github.whoCanAsk.exactOnly', 'Exact usernames only.')
      : null
  const limits = [
    // Whatever the list contributes to this answer (rows, a stranger's tag, an empty result, a
    // limit) is dated by this first line, with or without a heading in view. A host reads its
    // list once per app run; restart advice joins it only when that matters (a list read for
    // another scope or account, over an hour old, or no one in it matched).
    read
      ? read.reused &&
        (historical ||
          now - read.readAt > STALE_LIST_MS ||
          (query.trim() !== '' && shown.length === 0))
        ? remote
          ? list.earlierRemote
          : list.earlier
        : list.from
      : null,
    read?.omitted && !historical
      ? t('bots.github.whoCanAsk.omitted', 'Not every connected repo was read.')
      : null,
    read && !historical ? cutLine(read.cut, t) : null,
    read && !read.complete && !historical
      ? t('bots.github.whoCanAsk.notRead', 'Some repos or members couldn’t be read.')
      : null,
    ranked.length > shown.length
      ? t('bots.github.whoCanAsk.keepTyping', 'Keep typing to narrow.')
      : null,
    settledExact && !settledExact.ok
      ? t('bots.github.whoCanAsk.exactFailed', 'Username check failed.')
      : null,
    searchedAs &&
    ownerLogin &&
    !(linkedLogins ?? [ownerLogin]).some(
      (login) => login.toLowerCase() === searchedAs.toLowerCase()
    )
      ? t('bots.github.whoCanAsk.searchedAs', 'Repos read as @{{login}}.', {
          login: searchedAs
        })
      : null
  ]
  // One sentence per line, so no line wraps at the popover's width.
  const note = [rosterLine, exactOnly, ...limits].filter(Boolean).join('\n') || undefined

  const exactSearched = settledExact?.ok === true
  // An absence refers to the dated list in the heading, never to the repos as they are now.
  const searchedLine =
    !read || historical ? null : exactSearched ? list.searchedExact : list.searched
  // A roster still on its way: nothing definitive yet, whatever the exact lookup said.
  const empty =
    roster.status === 'loading'
      ? {
          title: t('bots.github.whoCanAsk.loadingTitle', 'Still loading your repos'),
          detail: exactSearched
            ? t('bots.github.whoCanAsk.noExactYet', 'No exact username match. Repos still coming.')
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
                ? rosterLine
                : [rosterLine, t('bots.github.whoCanAsk.tryExact', 'Try an exact username.')]
                    .filter(Boolean)
                    .join('\n')
          }
        : {
            title: t('bots.github.whoCanAsk.noPerson', 'No one found for “{{query}}”', { query }),
            detail: [searchedLine, note].filter(Boolean).join('\n')
          }

  return {
    ok: true,
    value: {
      members,
      // The note says what was left out, so the picker's generic "not everyone" line stays away.
      complete: true,
      // The note's first line dates the list; an absence refers to that list.
      labels: {
        scoped: historical
          ? list.historical
          : place === 'both'
            ? t('bots.github.whoCanAsk.reposOrgs', 'Your repos and orgs')
            : place === 'orgs'
              ? t('bots.github.whoCanAsk.orgs', 'Your orgs')
              : t('bots.github.whoCanAsk.repos', 'Your repos'),
        outsideTag: list.absent
      },
      ...(retired.length > 0 ? { retired } : {}),
      // The username check is still out: no empty result is final until it answers.
      ...(exact === 'pending' ? { pending: true as const } : {}),
      ...(note ? { note } : {}),
      empty,
      // A failed exact lookup or an unanswered list request can be asked again in place,
      // keeping the query, rows and picks.
      ...((settledExact && !settledExact.ok) || roster.status === 'unreached'
        ? { retryable: true }
        : {})
    }
  }
}
