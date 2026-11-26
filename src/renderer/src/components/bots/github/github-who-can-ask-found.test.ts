import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BotGitHubRoster,
  ConnectorGitHubUsersResponse
} from '../../../../../shared/connector-bot-github-contract'
import type { BotSlackResult } from '../../../../../shared/connector-bot-slack-contract'
import { gitHubWhoCanAskAnswer, type GitHubRosterState } from './github-who-can-ask-found'
import { readTime } from './github-who-can-ask-list-copy'

// This computer's own time and date text, built apart from the code under test, so the
// assertions hold in any locale; the clock is pinned where "today" matters.
const READ_AT = new Date(2026, 10, 19, 14, 5).getTime()
const clock = (ms: number) =>
  new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(ms)
const day = (ms: number) =>
  new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(ms)
const pinNow = (ms: number) => {
  vi.useFakeTimers()
  vi.setSystemTime(ms)
}
afterEach(() => {
  vi.useRealTimers()
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: echoes the English default like i18next does with no catalog.
const t = ((_key: string, fallback: string, values?: Record<string, unknown>) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(values?.[name] ?? ''))) as never

type Read = Extract<BotGitHubRoster, { status: 'read' }>
const scope = { repositories: ['acme/web'], owners: [], more: false }
const noCut = { people: false, members: false, repositories: false }
const read = (more: Partial<Read> = {}): BotGitHubRoster => ({
  status: 'read',
  people: [{ id: '2', login: 'brennanb2025', name: 'Brennan Benson' }],
  from: { repositories: true, organizations: false },
  complete: true,
  omitted: false,
  cut: noCut,
  readAt: READ_AT,
  reused: false,
  readFor: { scope, owner: 'owner' },
  ...more
})
type Exact = BotSlackResult<ConnectorGitHubUsersResponse>
const found: Exact = {
  ok: true,
  value: { members: [{ id: '9', name: 'brennan' }], complete: true }
}
const none: Exact = { ok: true, value: { members: [], complete: true } }
const failed: Exact = { ok: false, error: 'network' }
const off: Exact = { ok: false, error: 'github_off' }
const loading = { status: 'loading' } as const
const answer = (
  roster: GitHubRosterState,
  exact: Exact | null,
  query = 'brennan',
  producer: 'local' | 'remote' = 'local'
) => gitHubWhoCanAskAnswer({ roster, exact, query, ownerLogin: 'owner', scope, producer }, t)
// A read list's note starts with the line dating it; `after` is the rest, line by line.
const after = (note: string | undefined) => note?.split('\n').slice(1).join('\n') || undefined
const value = (result: ReturnType<typeof answer>) => {
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result.value
}

describe('the GitHub picker’s reading of a search', () => {
  it('calls an exact match outside only after a whole, uncut read of everything connected', () => {
    expect(value(answer(read(), found)).members).toEqual([
      { id: '2', name: 'brennanb2025', handle: 'Brennan Benson', group: 'scoped' },
      { id: '9', name: 'brennan', group: 'outside' }
    ])
    for (const partial of [
      read({ complete: false }),
      read({ omitted: true }),
      read({ cut: { ...noCut, members: true } })
    ]) {
      expect(value(answer(partial, found)).members.at(-1)).toEqual({
        id: '9',
        name: 'brennan',
        tag: 'Not all people loaded'
      })
    }
  })

  it('names only the kinds of source that were read', () => {
    const labels = (from: Read['from']) => value(answer(read({ from }), found)).labels
    // The note dates the list; the heading names it, and an absence refers to it.
    expect(labels({ repositories: true, organizations: false })?.scoped).toBe('Your repos')
    expect(labels({ repositories: false, organizations: true })).toEqual({
      scoped: 'Your orgs',
      outsideTag: 'Not in your org list'
    })
    expect(labels({ repositories: true, organizations: true })).toEqual({
      scoped: 'Your repos and orgs',
      outsideTag: 'Not in your GitHub list'
    })
  })

  it('explains each kind of fixed cut, and an omission, without advising typing', () => {
    const note = (more: Partial<Read>) => value(answer(read(more), none, 'zed')).note
    expect(after(note({ cut: { ...noCut, people: true } }))).toBe(
      'Showing the first 100 people per repo.'
    )
    expect(after(note({ cut: { ...noCut, members: true } }))).toBe(
      'Showing the first 100 members per org.'
    )
    expect(after(note({ cut: { ...noCut, repositories: true } }))).toBe(
      'Only your 5 latest repos were read.'
    )
    expect(after(note({ cut: { people: true, members: true, repositories: false } }))).toBe(
      'Some lists were only partly read.'
    )
    // A repo's people and a person's repos, no org at all: the line names no org.
    expect(after(note({ cut: { people: true, members: false, repositories: true } }))).toBe(
      'Some lists were only partly read.'
    )
    expect(after(note({ omitted: true }))).toBe('Not every connected repo was read.')
    // Only the shown-list cap is helped by typing.
    const many = Array.from({ length: 40 }, (_, index) => ({
      id: String(100 + index),
      login: `dev${index}`,
      name: null
    }))
    expect(after(value(answer(read({ people: many }), none, 'dev')).note)).toBe(
      'Keep typing to narrow.'
    )
  })

  it('never says no one was found while the roster is still loading', () => {
    expect(value(answer(loading, null, 'neil par')).empty).toEqual({
      title: 'Still loading your repos',
      detail: 'Results appear when they load.'
    })
    expect(value(answer(loading, none)).empty).toEqual({
      title: 'Still loading your repos',
      detail: 'No exact username match. Repos still coming.'
    })
    // A useful exact match shows now, tagged as not yet checked against the repos.
    expect(value(answer(loading, found)).members).toEqual([
      { id: '9', name: 'brennan', tag: 'Repos still loading' }
    ])
    // A failed exact lookup waits for the roster rather than failing the whole search.
    // No list yet, so no dated line: one sentence per line.
    expect(value(answer(loading, failed)).note).toBe(
      'Still loading your repos.\nUsername check failed.'
    )
  })

  it('fails only when nothing was connected to look in, and always when GitHub is off', () => {
    expect(answer({ status: 'none' }, failed)).toEqual(failed)
    // A list that couldn't be read and a failed check: both are said, and the check can be asked again.
    expect(value(answer({ status: 'unavailable', spent: true }, failed))).toMatchObject({
      members: [],
      retryable: true,
      empty: { detail: 'Couldn’t read repos. Check gh, restart Orca.\nUsername check failed.' }
    })
    expect(answer(read(), off)).toEqual(off)
    expect(answer(loading, off)).toEqual(off)
    // The failed lookup can be asked again in place (the picker's Try again).
    expect(value(answer(read(), failed)).retryable).toBe(true)
    expect(after(value(answer(read(), failed)).note)).toBe('Username check failed.')
    expect(value(answer(read(), none)).retryable).toBeUndefined()
  })

  it('says only what a settled empty search looked at', () => {
    pinNow(READ_AT + 10 * 60_000)
    const empty = (roster: GitHubRosterState, exact: Exact | null, query = 'zed') =>
      value(answer(roster, exact, query)).empty
    expect(empty(read(), none)).toEqual({
      title: 'No one found for “zed”',
      detail: `Searched your repo list and exact usernames.\nRepo list from ${clock(READ_AT)}.`
    })
    expect(empty(read(), null, 'neil par')?.detail).toMatch(
      /^Searched your repo list\.\nRepo list from /
    )
    // Nothing readable asked for: nothing spent, and no gh advice.
    expect(empty({ status: 'unavailable', spent: false }, null, 'neil par')?.detail).toBe(
      'No readable repos to search.'
    )
    // The host never answered: a new open asks again.
    expect(empty({ status: 'unreached' }, null, 'neil par')?.detail).toBe(
      'Couldn’t get the repo list.'
    )
    expect(empty({ status: 'unavailable', spent: true }, none)?.detail).toBe(
      'Couldn’t read repos. Check gh, restart Orca.'
    )
    expect(empty({ status: 'unavailable', spent: true }, null, 'neil par')).toEqual({
      title: 'Couldn’t search for “neil par”',
      detail: 'Couldn’t read repos. Check gh, restart Orca.'
    })
    expect(empty({ status: 'skipped' }, null, 'neil par')?.detail).toBe('Try an exact username.')
  })

  it('says when a reused list was read only when that matters, with the date when not today', () => {
    const readAt = READ_AT
    const at = (now: number, query: string) =>
      gitHubWhoCanAskAnswer(
        {
          roster: read({ reused: true }),
          exact: none,
          query,
          ownerLogin: 'owner',
          scope,
          producer: 'local',
          now
        },
        t
      )
    const note = (result: ReturnType<typeof at>) => (result.ok ? result.value.note : undefined)
    const minutes = (count: number) => readAt + count * 60_000
    // Every answer from a list dates it; restart advice joins only when it matters.
    // Recent, and the search found someone in it: the date alone.
    const today = `Repo list from ${clock(readAt)}.`
    const advice = `Repo list from ${clock(readAt)}. Restart Orca to refresh.`
    expect(note(at(minutes(10), 'brennan'))).toBe(today)
    expect(note(at(minutes(10), ''))).toBe(today)
    // Recent, but no one in it matched: the list's age could be why.
    expect(note(at(minutes(10), 'zed'))).toBe(advice)
    // Over an hour old: always, with the time today...
    expect(note(at(minutes(90), 'brennan'))).toBe(advice)
    // ...and the date once it's another day (date and time wouldn't fit one line).
    expect(note(at(minutes(60 * 20), 'brennan'))).toBe(
      `Repo list from ${day(readAt)}. Restart Orca to refresh.`
    )
    // A list read during this open is dated too, without restart advice.
    expect(value(answer(read(), none)).note).toMatch(/^Repo list from [^.]+\.$/)
  })

  it('treats a list read for another scope or account as history, claiming nothing current', () => {
    const now = new Date(2026, 10, 19, 14, 15).getTime()
    const at = (
      readFor: Read['readFor'],
      exact: Exact,
      query = 'brennan',
      owner: string | null = 'owner'
    ) =>
      gitHubWhoCanAskAnswer(
        {
          roster: read({ reused: true, readFor }),
          exact,
          query,
          ownerLogin: owner,
          scope,
          producer: 'local',
          now
        },
        t
      )
    const histories: [string, Read['readFor'], string | null][] = [
      [
        'another scope (repos added or removed)',
        { scope: { ...scope, repositories: ['acme/api'] }, owner: 'owner' },
        'owner'
      ],
      ['another linked account', { scope, owner: 'someone-else' }, 'owner'],
      ['an unknown account then', { scope, owner: null }, 'owner'],
      ['an unknown account now', { scope, owner: 'owner' }, null]
    ]
    for (const [label, readFor, owner] of histories) {
      const result = at(readFor, found, 'brennan', owner)
      const found_ = result.ok ? result.value : null
      expect(found_?.labels?.scoped, label).toBe('From an earlier repo list')
      // The stranger isn't called an outsider: an old list proves no current absence.
      expect(found_?.members.at(-1), label).toEqual({
        id: '9',
        name: 'brennan',
        tag: 'Not in the earlier list'
      })
      // Recent and matched, yet it still says when the list is from.
      expect(found_?.note, label).toBe(`Repo list from ${clock(READ_AT)}. Restart Orca to refresh.`)
    }
    // The same scope and account, read this run: current.
    const same = at({ scope, owner: 'owner' }, found)
    expect(same.ok && same.value.labels?.scoped).toBe('Your repos')
  })

  it('keeps a live exact match visible however the list holds that person', () => {
    const renamed = read({ people: [{ id: '9', login: 'old-name', name: null }] })
    // In the list under an old login that doesn't match: shown by its current login.
    expect(value(answer(renamed, found)).members).toEqual([
      { id: '9', name: 'brennan', group: 'scoped' }
    ])
    // Already shown: one row, with the current login.
    const shown = read({ people: [{ id: '9', login: 'brennan-old', name: 'Brennan' }] })
    expect(value(answer(shown, found, 'brennan')).members).toEqual([
      { id: '9', name: 'brennan', handle: 'Brennan', group: 'scoped' }
    ])
    // Past the shown cap: still shown, once.
    const many = Array.from({ length: 40 }, (_, index) => ({
      id: String(100 + index),
      login: `brennan${index}`,
      name: null
    }))
    const capped = read({ people: [...many, { id: '9', login: 'brennanz', name: null }] })
    const members = value(answer(capped, found, 'brennan')).members
    expect(members.filter((member) => member.id === '9')).toEqual([
      { id: '9', name: 'brennan', group: 'scoped' }
    ])
  })

  it('points restart advice at the computer that read the list', () => {
    expect(value(answer({ status: 'unavailable', spent: true }, none, 'zed', 'remote')).note).toBe(
      'Couldn’t read repos. Check the bot’s computer.'
    )
    pinNow(READ_AT)
    const earlier = new Date(2026, 10, 1).getTime()
    const old = read({ reused: true, readAt: earlier })
    expect(value(answer(old, none, 'brennan', 'remote')).note).toBe(
      `Repo list from ${day(earlier)}. Restart the bot’s Orca.`
    )
  })

  it('names a different gh account, and not the same one', () => {
    expect(after(value(answer(read({ searchedAs: 'someone-else' }), none)).note)).toBe(
      'Repos read as @someone-else.'
    )
    expect(after(value(answer(read({ searchedAs: 'OWNER' }), none)).note)).toBeUndefined()
  })
})

describe('when a list was read', () => {
  const sameDay = READ_AT + 30 * 60_000
  const nextDay = READ_AT + 20 * 60 * 60_000
  it('says the time on the same local day and the date on a later one, 12-hour', () => {
    expect(readTime(READ_AT, sameDay, 'en-US')).toMatch(/^2:05\sPM$/u)
    expect(readTime(READ_AT, nextDay, 'en-US')).toBe('Nov 19')
  })
  it('follows a 24-hour locale', () => {
    expect(readTime(READ_AT, sameDay, 'en-GB')).toBe('14:05')
    expect(readTime(READ_AT, nextDay, 'en-GB')).toBe('19 Nov')
  })
})

describe('GPS-C6-07: a loss or omission is named by the kind it hit', () => {
  const mixed = { repositories: ['acme/web'], owners: ['acme'], more: false }
  const orgsOnly = { repositories: [], owners: ['acme'], more: false }
  const noteOf = (asked: Read['readFor']['scope'], more: Partial<Read>) =>
    value(
      gitHubWhoCanAskAnswer(
        {
          roster: read({ readFor: { scope: asked, owner: 'owner' }, ...more }),
          exact: none,
          query: 'brennan',
          ownerLogin: 'owner',
          scope: asked,
          producer: 'local'
        },
        t
      )
    ).note ?? ''
  const orgsRead = { repositories: false, organizations: true }

  it('orgs read and a repo lost: a repo loss, never an org one', () => {
    const note = noteOf(mixed, {
      from: orgsRead,
      complete: false,
      lost: { repositories: true, organizations: false, unattributed: false }
    })
    expect(note).toContain('Some repos or members couldn’t be read.')
    expect(note).not.toContain('Some orgs couldn’t be read.')
  })

  it('repos read and an org lost: an org loss, never a repo one', () => {
    const note = noteOf(mixed, {
      complete: false,
      lost: { repositories: false, organizations: true, unattributed: false }
    })
    expect(note).toContain('Some orgs couldn’t be read.')
    expect(note).not.toContain('Some repos or members couldn’t be read.')
  })

  it('names both kinds when the lost kind is unknown, from any host', () => {
    const unattributed = { repositories: false, organizations: false, unattributed: true }
    expect(noteOf(mixed, { from: orgsRead, complete: false, lost: unattributed })).toContain(
      'Some repos or orgs couldn’t be read.'
    )
    // An older host doesn't say what it lost.
    expect(noteOf(mixed, { from: orgsRead, complete: false })).toContain(
      'Some repos or orgs couldn’t be read.'
    )
  })

  it('clipped: an omission from a mixed or account request names both kinds', () => {
    for (const asked of [mixed, orgsOnly]) {
      const note = noteOf(asked, { from: orgsRead, omitted: true })
      expect(note).toContain('Not every connected repo or org was read.')
      expect(note).not.toContain('Not every connected org was read.')
    }
    expect(noteOf(scope, { omitted: true })).toContain('Not every connected repo was read.')
  })

  it('keeps the pure-org loss, the reader and the date', () => {
    const note = noteOf(orgsOnly, {
      from: orgsRead,
      complete: false,
      lost: { repositories: false, organizations: true, unattributed: false },
      searchedAs: 'other-reader'
    })
    expect(note.split('\n')[0]).toMatch(/^Org list from /)
    expect(note).toContain('Some orgs couldn’t be read.')
    expect(note).toContain('Orgs read as @other-reader.')
  })
})
