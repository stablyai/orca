import { describe, expect, it } from 'vitest'
import type {
  BotGitHubRoster,
  ConnectorGitHubUsersResponse
} from '../../../../../shared/connector-bot-github-contract'
import type { BotSlackResult } from '../../../../../shared/connector-bot-slack-contract'
import { gitHubWhoCanAskAnswer, type GitHubRosterState } from './github-who-can-ask-found'

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
  readAt: new Date(2026, 10, 19, 14, 5).getTime(),
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
    expect(labels({ repositories: true, organizations: false })?.scoped).toBe('Found in your repos')
    expect(labels({ repositories: false, organizations: true })).toEqual({
      scoped: 'Found in your orgs',
      outsideTag: 'Not found in your orgs'
    })
    expect(labels({ repositories: true, organizations: true })?.scoped).toBe(
      'Found in your repos and orgs'
    )
  })

  it('explains each kind of fixed cut, and an omission, without advising typing', () => {
    const note = (more: Partial<Read>) => value(answer(read(more), none, 'zed')).note
    expect(note({ cut: { ...noCut, people: true } })).toBe('Showing the first 100 people per repo.')
    expect(note({ cut: { ...noCut, members: true } })).toBe(
      'Showing the first 100 members per org.'
    )
    expect(note({ cut: { ...noCut, repositories: true } })).toBe(
      'Only your 5 latest repos were read.'
    )
    expect(note({ cut: { people: true, members: true, repositories: false } })).toBe(
      'Some lists were only partly read.'
    )
    // A repo's people and a person's repos, no org at all: the line names no org.
    expect(note({ cut: { people: true, members: false, repositories: true } })).toBe(
      'Some lists were only partly read.'
    )
    expect(note({ omitted: true })).toBe('Not every connected repo was read.')
    // Only the shown-list cap is helped by typing.
    const many = Array.from({ length: 40 }, (_, index) => ({
      id: String(100 + index),
      login: `dev${index}`,
      name: null
    }))
    expect(value(answer(read({ people: many }), none, 'dev')).note).toBe('Keep typing to narrow.')
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
    expect(value(answer(loading, failed)).note).toBe(
      'Still loading your repos. Username check failed.'
    )
  })

  it('fails only when nothing could look, and always when GitHub is off', () => {
    expect(answer({ status: 'unavailable' }, failed)).toEqual(failed)
    expect(answer(read(), off)).toEqual(off)
    expect(answer(loading, off)).toEqual(off)
    // The failed lookup can be asked again in place (the picker's Try again).
    expect(value(answer(read(), failed))).toMatchObject({
      note: 'Username check failed.',
      retryable: true
    })
    expect(value(answer(read(), none)).retryable).toBeUndefined()
  })

  it('says only what a settled empty search looked at', () => {
    const empty = (roster: GitHubRosterState, exact: Exact | null, query = 'zed') =>
      value(answer(roster, exact, query)).empty
    expect(empty(read(), none)).toEqual({
      title: 'No one found for “zed”',
      detail: 'Searched your repos and exact usernames.'
    })
    expect(empty(read(), null, 'neil par')?.detail).toBe('Searched your repos.')
    expect(empty({ status: 'unavailable' }, none)?.detail).toBe(
      'Couldn’t read repos. Check gh, restart Orca.'
    )
    expect(empty({ status: 'unavailable' }, null, 'neil par')).toEqual({
      title: 'Couldn’t search for “neil par”',
      detail: 'Couldn’t read repos. Check gh, restart Orca.'
    })
    expect(empty({ status: 'skipped' }, null, 'neil par')?.detail).toBe('Try an exact username.')
  })

  it('says when a reused list was read only when that matters, with the date when not today', () => {
    const readAt = new Date(2026, 10, 19, 14, 5).getTime()
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
    // Recent, and the search found someone in it: nothing to say.
    expect(note(at(minutes(10), 'brennan'))).toBeUndefined()
    expect(note(at(minutes(10), ''))).toBeUndefined()
    // Recent, but no one in it matched: the list's age could be why.
    expect(note(at(minutes(10), 'zed'))).toMatch(
      /^Repo list from 2:05\s?PM\. Restart Orca to refresh\.$/
    )
    // Over an hour old: always, with the time today...
    expect(note(at(minutes(90), 'brennan'))).toMatch(/^Repo list from 2:05\s?PM\./)
    // ...and the date once it's another day (date and time wouldn't fit one line).
    expect(note(at(minutes(60 * 20), 'brennan'))).toMatch(
      /^Repo list from Nov 19\. Restart Orca to refresh\.$/
    )
    // A list read during this open is never labelled.
    expect(value(answer(read(), none)).note).toBeUndefined()
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
      expect(found_?.note, label).toMatch(/^Repo list from 2:05\s?PM\. Restart Orca to refresh\.$/)
    }
    // The same scope and account, read this run: current.
    const same = at({ scope, owner: 'owner' }, found)
    expect(same.ok && same.value.labels?.scoped).toBe('Found in your repos')
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
    expect(value(answer({ status: 'unavailable' }, none, 'zed', 'remote')).note).toBe(
      'Couldn’t read repos. Check the bot’s computer.'
    )
    const old = read({ reused: true, readAt: new Date(2026, 10, 1).getTime() })
    expect(value(answer(old, none, 'brennan', 'remote')).note).toBe(
      'Repo list from Nov 1. Restart the bot’s Orca.'
    )
  })

  it('names a different gh account, and not the same one', () => {
    expect(value(answer(read({ searchedAs: 'someone-else' }), none)).note).toBe(
      'Repos read as @someone-else.'
    )
    expect(value(answer(read({ searchedAs: 'OWNER' }), none)).note).toBeUndefined()
  })
})
