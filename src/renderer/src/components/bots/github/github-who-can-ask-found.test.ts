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

const read = (
  more: Partial<Extract<BotGitHubRoster, { status: 'read' }>> = {}
): BotGitHubRoster => ({
  status: 'read',
  people: [{ id: '2', login: 'brennanb2025', name: 'Brennan Benson' }],
  from: { repositories: true, organizations: false },
  complete: true,
  cut: false,
  ...more
})
const found: BotSlackResult<ConnectorGitHubUsersResponse> = {
  ok: true,
  value: { members: [{ id: '9', name: 'brennan' }], complete: true }
}
const none: BotSlackResult<ConnectorGitHubUsersResponse> = {
  ok: true,
  value: { members: [], complete: true }
}
const failed: BotSlackResult<ConnectorGitHubUsersResponse> = { ok: false, error: 'network' }
const answer = (
  roster: GitHubRosterState,
  exact: BotSlackResult<ConnectorGitHubUsersResponse> | null,
  query = 'brennan'
) => gitHubWhoCanAskAnswer({ roster, exact, query, ownerLogin: 'owner' }, t)
const value = (result: ReturnType<typeof answer>) => {
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result.value
}

describe('the GitHub picker’s reading of a search', () => {
  it('lists roster matches, and calls an exact match outside only after a whole read', () => {
    expect(value(answer(read(), found)).members).toEqual([
      { id: '2', name: 'brennanb2025', handle: 'Brennan Benson', group: 'scoped' },
      { id: '9', name: 'brennan', group: 'outside' }
    ])
    for (const partial of [read({ complete: false }), read({ cut: true })]) {
      expect(value(answer(partial, found)).members.at(-1)).toEqual({
        id: '9',
        name: 'brennan',
        tag: 'Not all people loaded'
      })
    }
    for (const missing of [
      { status: 'unavailable' } as const,
      { status: 'busy' } as const,
      { status: 'none' } as const,
      { status: 'skipped' } as const
    ]) {
      expect(value(answer(missing, found)).members).toEqual([
        { id: '9', name: 'brennan', tag: 'Repos not checked' }
      ])
    }
  })

  it('names only the kinds of source that were read', () => {
    const labels = (from: { repositories: boolean; organizations: boolean }) =>
      value(answer(read({ from }), found)).labels
    expect(labels({ repositories: true, organizations: false })).toEqual({
      scoped: 'Found in your repos',
      outsideTag: 'Not found in your repos'
    })
    expect(labels({ repositories: false, organizations: true })).toEqual({
      scoped: 'Found in your orgs',
      outsideTag: 'Not found in your orgs'
    })
    expect(labels({ repositories: true, organizations: true })?.scoped).toBe(
      'Found in your repos and orgs'
    )
  })

  it('reports an error when nothing could look, and always when GitHub is off', () => {
    expect(answer({ status: 'unavailable' }, failed)).toEqual(failed)
    const off = { ok: false as const, error: 'github_off' }
    expect(answer(read(), off)).toEqual(off)
    // A read roster with the exact lookup failing keeps its results and says so.
    expect(value(answer(read(), failed)).note).toBe('Couldn’t check GitHub usernames.')
  })

  it('says only what an empty search looked at', () => {
    const empty = (roster: GitHubRosterState, exact: typeof found | null, query = 'zed') =>
      value(answer(roster, exact, query)).empty
    expect(empty(read(), none)).toEqual({
      title: 'No one found for “zed”',
      detail: 'Searched your repos and exact usernames.'
    })
    expect(empty(read(), null, 'neil par')?.detail).toBe('Searched your repos.')
    expect(empty({ status: 'unavailable' }, none)?.detail).toBe(
      'Couldn’t read repos. Exact usernames only.'
    )
    expect(empty({ status: 'unavailable' }, null, 'neil par')).toEqual({
      title: 'Couldn’t search for “neil par”',
      detail: 'Couldn’t read repos. Try an exact username.'
    })
    expect(empty({ status: 'skipped' }, null, 'neil par')?.detail).toBe('Try an exact username.')
    // Which computer goes unsaid, local or remote: the line stays one line.
    expect(value(answer({ status: 'unavailable' }, none, 'zed')).note).toBe(
      'Couldn’t read repos. Exact usernames only.'
    )
  })

  it('advises typing only for the shown-list cap, and states a fixed per-repo cut plainly', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      id: String(100 + index),
      login: `dev${index}`,
      name: null
    }))
    expect(value(answer(read({ people: many }), none, 'dev')).note).toBe('Keep typing to narrow.')
    expect(value(answer(read({ cut: true }), none)).note).toBe(
      'Showing the first 100 people per repo.'
    )
    expect(value(answer(read({ searchedAs: 'someone-else' }), none)).note).toBe(
      'Repos read as @someone-else.'
    )
    expect(value(answer(read({ searchedAs: 'OWNER' }), none)).note).toBeUndefined()
  })
})
