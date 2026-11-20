import { describe, expect, it } from 'vitest'
import type { BotGitHubPeople } from '../../../../../shared/connector-bot-github-contract'
import { gitHubWhoCanAskFound } from './github-who-can-ask-found'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: echoes the English default like i18next does with no catalog.
const t = ((_key: string, fallback: string, values?: Record<string, string>) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => values?.[name] ?? '')) as never

const context = { query: 'brennan', ownerLogin: 'owner', withOrganizations: false }
const read = (people: BotGitHubPeople, query = 'brennan') =>
  gitHubWhoCanAskFound(people, { ...context, query }, t)
const coverage = (
  local: string,
  exact: string,
  more: { narrowable?: boolean; searchedAs?: string } = {}
) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test table over the contract's string unions.
  ({ local, exact, ...more }) as NonNullable<BotGitHubPeople['coverage']>

describe('the GitHub picker’s reading of a search', () => {
  it('groups by where people were found and tags matches the repos could not vouch for', () => {
    expect(
      read({
        members: [
          { id: '2', name: 'brennanb2025', handle: 'Brennan Benson', found: 'scope' },
          { id: '9', name: 'brennan', found: 'outside' }
        ],
        complete: true,
        coverage: coverage('full', 'searched', { searchedAs: 'owner' })
      }).members
    ).toEqual([
      { id: '2', name: 'brennanb2025', handle: 'Brennan Benson', group: 'scoped' },
      { id: '9', name: 'brennan', group: 'outside' }
    ])
    expect(
      read({
        members: [{ id: '9', name: 'brennan', found: 'exact' }],
        complete: false,
        coverage: coverage('limited', 'searched')
      }).members
    ).toEqual([{ id: '9', name: 'brennan', tag: 'Not all repos checked' }])
  })

  it('never claims an older host checked repos', () => {
    const found = read({ members: [{ id: '9', name: 'brennan' }], complete: true })
    expect(found.members).toEqual([{ id: '9', name: 'brennan', tag: 'Repos not checked' }])
    expect(found.note).toBe('Exact usernames only.')
    expect(found.empty?.detail).toBe('Checked exact usernames only.')
  })

  it('says only what an empty search looked at', () => {
    const empty = (c: NonNullable<BotGitHubPeople['coverage']>, query = 'brennan') =>
      read({ members: [], complete: false, coverage: c }, query).empty
    expect(empty(coverage('full', 'searched'))).toEqual({
      title: 'No one found for “brennan”',
      detail: 'Searched your repos and exact usernames.'
    })
    // A spaced name skips the exact lookup: it is not claimed.
    expect(empty(coverage('full', 'skipped'), 'neil par')?.detail).toBe('Searched your repos.')
    expect(empty(coverage('unavailable', 'searched'))?.detail).toBe(
      'Repos unavailable here. Exact usernames only.'
    )
    expect(empty(coverage('none', 'searched'))?.detail).toBe(
      'No repos connected. Exact usernames only.'
    )
    // Nothing was searched at all: no "no one found".
    expect(empty(coverage('unavailable', 'skipped'), 'neil par')).toEqual({
      title: 'Couldn’t search for “neil par”',
      detail: 'Repos unavailable here. Try an exact username.'
    })
    expect(empty(coverage('skipped', 'skipped'), 'neil par')).toEqual({
      title: 'Couldn’t search for “neil par”',
      detail: 'Try an exact username.'
    })
  })

  it('gives advice that fits the limit, and names a different gh account', () => {
    const note = (c: NonNullable<BotGitHubPeople['coverage']>) =>
      read({ members: [], complete: false, coverage: c }).note
    expect(note(coverage('limited', 'searched', { narrowable: true }))).toBe(
      'Partial results. Keep typing to narrow.'
    )
    expect(note(coverage('limited', 'searched'))).toBe('Some repos or members weren’t searched.')
    expect(note(coverage('full', 'failed', { searchedAs: 'someone-else' }))).toBe(
      'Couldn’t check GitHub usernames. Repos searched as @someone-else on this computer.'
    )
    expect(note(coverage('full', 'searched', { searchedAs: 'OWNER' }))).toBeUndefined()
  })
})
