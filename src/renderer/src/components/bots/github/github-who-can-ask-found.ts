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
import type { WhoCanAskIdentity } from '../who-can-ask-identity-ledger'
import {
  cutLine,
  listCopy,
  readTime,
  requestCopy,
  type ListKind
} from './github-who-can-ask-list-copy'

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
  /** What live checks this picker open said about a listed person (default: nothing). */
  identity?: (id: string, login: string) => WhoCanAskIdentity
}

/** A reused list older than this is worth mentioning on every search. */
export const STALE_LIST_MS = 60 * 60_000

/** One search as the picker draws it. Every line says only what was actually read: an empty list
 *  never reads as "no one exists" when nothing, or not everything, was looked at, and a list read
 *  for another scope or account makes no claim about the current ones. */
export function gitHubWhoCanAskAnswer(
  {
    roster,
    exact,
    query,
    ownerLogin,
    linkedLogins,
    scope,
    producer,
    now = Date.now(),
    identity = () => ({ status: 'unknown' })
  }: Answer,
  t: Translate
): BotSlackResult<BotWhoCanAskFound> {
  const settledExact = exact === 'pending' ? null : exact
  const exactFailed = settledExact !== null && !settledExact.ok
  // GitHub off, as the cloud just said, is definitive; so is a failed lookup with nothing else
  // that could have looked (nothing connected, or the state not known yet).
  if (
    settledExact &&
    !settledExact.ok &&
    (settledExact.error === BOT_GITHUB_OFF ||
      roster.status === 'none' ||
      roster.status === 'skipped' ||
      roster.status === 'exact-only')
  ) {
    return settledExact
  }
  const request = requestCopy(
    scope !== undefined && scope.owners.length === 0 && scope.repositories.length > 0,
    t
  )
  if (roster.status === 'exact-only') {
    // This host reads no list (Windows): exact usernames only, as before the list existed.
    const only = t('bots.github.whoCanAsk.exactOnly', 'Exact usernames only.')
    return {
      ok: true,
      value: {
        members: settledExact?.ok ? [...settledExact.value.members] : [],
        complete: true,
        note: only,
        empty: {
          title: t('bots.github.whoCanAsk.noPerson', 'No one found for “{{query}}”', { query }),
          detail: only
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
  const place: ListKind =
    read?.from.organizations && read.from.repositories
      ? 'both'
      : read?.from.organizations
        ? 'orgs'
        : 'repos'
  const list = listCopy(place, read ? readTime(read.readAt, now) : '', searchedAs ?? '', t)
  // A loss or omission is named by the kind it hit, never by the kind that read fine: by what the
  // host says it lost, else by what the read asked for (repos alone), else by both kinds.
  const asked = read?.readFor.scope
  const reposAsked = asked !== undefined && asked.owners.length === 0
  const lostKind: ListKind = !read?.lost
    ? reposAsked
      ? 'repos'
      : 'both'
    : read.lost.unattributed || read.lost.repositories === read.lost.organizations
      ? 'both'
      : read.lost.organizations
        ? 'orgs'
        : 'repos'
  const loss = listCopy(lostKind, '', '', t)
  const omission = listCopy(reposAsked ? 'repos' : 'both', '', '', t)

  // The list as live checks left it: a login a newer check gave to someone else is not this
  // person's, and a confirmed new login replaces the listed one, before matching and the cut.
  const people = (read?.people ?? []).flatMap((person) => {
    const known = identity(person.id, person.login)
    return known.status === 'contradicted'
      ? []
      : [known.status === 'current' ? { ...person, login: known.name } : person]
  })
  const ranked = rankGitHubPeople(people, query)
  const shown = ranked.slice(0, GITHUB_PEOPLE_SHOWN)
  const listed = new Map(people.map((person) => [person.id, person]))
  const cut = read ? read.cut.people || read.cut.members || read.cut.repositories : false
  // Only a whole, uncut, current read of everything connected shows the list doesn't hold someone.
  const whole = read !== null && read.complete && !read.omitted && !cut && !historical
  const uncheckedTag =
    roster.status === 'loading'
      ? request.loadingTag
      : historical
        ? t('bots.github.whoCanAsk.notInEarlierList', 'Not in the earlier list')
        : read
          ? t('bots.github.whoCanAsk.notAllLoaded', 'Not all people loaded')
          : request.uncheckedTag
  const realName = (person: { login: string; name: string | null }) =>
    person.name && person.name !== person.login ? { handle: person.name } : {}
  const members: BotWhoCanAskFound['members'] = shown.map((person) => ({
    id: person.id,
    name: person.login,
    group: 'scoped' as const,
    ...realName(person)
  }))
  for (const member of settledExact?.ok ? settledExact.value.members : []) {
    const row = members.find((shownRow) => shownRow.id === member.id)
    const inList = listed.get(member.id)
    if (row) {
      // Already shown: the live lookup's login is current (the list's may be from before a rename).
      row.name = member.name
    } else if (inList) {
      // In the list under another login, or past the shown cap: by its current login, with the
      // list's real name.
      members.push({
        id: member.id,
        name: member.name,
        group: 'scoped' as const,
        ...realName({ ...inList, login: member.name })
      })
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
      ? request.loading
      : roster.status === 'unavailable' && !roster.spent
        ? // Nothing readable was asked for: no gh ran and nothing was used up.
          request.noReadable
        : roster.status === 'unavailable'
          ? remote
            ? request.unavailableRemote
            : request.unavailable
          : roster.status === 'unreached'
            ? request.unreached
            : roster.status === 'none'
              ? t('bots.github.whoCanAsk.localNone', 'No repos or orgs connected.')
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
    read?.omitted && !historical ? omission.omitted : null,
    read && !historical ? cutLine(read.cut, t) : null,
    read && !read.complete && !historical ? loss.unread : null,
    ranked.length > shown.length
      ? t('bots.github.whoCanAsk.keepTyping', 'Keep typing to narrow.')
      : null,
    exactFailed ? t('bots.github.whoCanAsk.exactFailed', 'Username check failed.') : null,
    searchedAs &&
    ownerLogin &&
    !(linkedLogins ?? [ownerLogin]).some(
      (login) => login.toLowerCase() === searchedAs.toLowerCase()
    )
      ? list.readAs
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
          title: request.loadingTitle,
          detail: exactSearched
            ? request.noExactYet
            : t('bots.github.whoCanAsk.resultsComing', 'Results appear when they load.')
        }
      : !read && !exactSearched
        ? {
            title: t('bots.github.whoCanAsk.couldNotSearch', 'Couldn’t search for “{{query}}”', {
              query
            }),
            // The unavailable line already says what to do; the exact-username hint would wrap it.
            // Both failures stay named when the list and the check both failed.
            detail:
              (roster.status === 'unavailable' || roster.status === 'unreached') && rosterLine
                ? [
                    rosterLine,
                    exactFailed
                      ? t('bots.github.whoCanAsk.exactFailed', 'Username check failed.')
                      : null
                  ]
                    .filter(Boolean)
                    .join('\n')
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
      // The username check is still out: no empty result is final until it answers.
      ...(exact === 'pending' ? { pending: true as const } : {}),
      ...(note ? { note } : {}),
      empty,
      // A failed exact lookup or an unanswered list request can be asked again in place,
      // keeping the query, rows and picks.
      ...(exactFailed || roster.status === 'unreached' ? { retryable: true } : {})
    }
  }
}
