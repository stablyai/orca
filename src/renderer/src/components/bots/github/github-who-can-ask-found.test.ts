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
const noCut = { people: false, members: false, repositories: false }
const read = (more: Partial<Read> = {}): BotGitHubRoster => ({
  status: 'read',
  people: [{ id: '2', login: 'brennanb2025', name: 'Brennan Benson' }],
  from: { repositories: true, organizations: false },
  complete: true,
  omitted: false,
  cut: noCut,
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
const answer = (roster: GitHubRosterState, exact: Exact | null, query = 'brennan') =>
  gitHubWhoCanAskAnswer({ roster, exact, query, ownerLogin: 'owner' }, t)
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
      'Large repos and orgs were only partly read.'
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
      'Still loading your repos. Couldn’t check GitHub usernames.'
    )
  })

  it('fails only when nothing could look, and always when GitHub is off', () => {
    expect(answer({ status: 'unavailable' }, failed)).toEqual(failed)
    expect(answer(read(), off)).toEqual(off)
    expect(answer(loading, off)).toEqual(off)
    expect(value(answer(read(), failed)).note).toBe('Couldn’t check GitHub usernames.')
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
      'Couldn’t read repos. Exact usernames only.'
    )
    expect(empty({ status: 'busy' }, null, 'neil par')).toEqual({
      title: 'Couldn’t search for “neil par”',
      detail: 'Repo list is busy. Reopen to try again.'
    })
    expect(empty({ status: 'skipped' }, null, 'neil par')?.detail).toBe('Try an exact username.')
  })

  it('names a different gh account, and not the same one', () => {
    expect(value(answer(read({ searchedAs: 'someone-else' }), none)).note).toBe(
      'Repos read as @someone-else.'
    )
    expect(value(answer(read({ searchedAs: 'OWNER' }), none)).note).toBeUndefined()
  })
})
