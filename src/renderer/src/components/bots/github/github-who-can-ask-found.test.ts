import { describe, expect, it } from 'vitest'
import { gitHubWhoCanAskFound } from './github-who-can-ask-found'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: echoes the English default like i18next does with no catalog.
const t = ((_key: string, fallback: string, values?: Record<string, string>) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => values?.[name] ?? '')) as never

describe('the GitHub picker’s reading of a search', () => {
  it('groups by where people were found and leaves an older host’s members unlabelled', () => {
    expect(
      gitHubWhoCanAskFound(
        {
          members: [
            { id: '2', name: 'brennanb2025', handle: 'Brennan Benson', found: 'scope' },
            { id: '9', name: 'brennan', found: 'outside' },
            { id: '8', name: 'jordan', found: 'exact' }
          ],
          complete: true,
          coverage: { local: 'full', exact: 'searched', searchedAs: 'owner' }
        },
        'owner',
        t
      )
    ).toEqual({
      members: [
        { id: '2', name: 'brennanb2025', handle: 'Brennan Benson', group: 'scoped' },
        { id: '9', name: 'brennan', group: 'outside' },
        { id: '8', name: 'jordan', tag: 'Repos not checked' }
      ],
      complete: true
    })
    expect(
      gitHubWhoCanAskFound({ members: [{ id: '9', name: 'x' }], complete: false }, null, t)
    ).toEqual({ members: [{ id: '9', name: 'x' }], complete: false })
  })

  it('notes an unavailable search, a failed exact lookup and a different gh account', () => {
    const found = gitHubWhoCanAskFound(
      {
        members: [],
        complete: false,
        coverage: { local: 'unavailable', exact: 'failed', searchedAs: 'someone-else' }
      },
      'owner',
      t
    )
    expect(found.note).toBe(
      'Repos unavailable here. Exact usernames only. Couldn’t check GitHub usernames. ' +
        'Repos searched as @someone-else on this computer.'
    )
    expect(
      gitHubWhoCanAskFound(
        { members: [], complete: false, coverage: { local: 'limited', exact: 'skipped' } },
        'owner',
        t
      ).note
    ).toBe('Partial results. Keep typing to narrow.')
  })
})
