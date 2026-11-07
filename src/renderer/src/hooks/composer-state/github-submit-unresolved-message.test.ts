import { describe, expect, it } from 'vitest'
import { getSmartGitHubSubmitIntent, type SmartGitHubSubmitIntent } from '@/lib/smart-github-submit'
import { getUnresolvedSmartGitHubSubmitMessage } from './github-submit-unresolved-message'

const GENERIC = 'Could not resolve the GitHub item before creating the workspace.'

function intentFor(input: string): SmartGitHubSubmitIntent {
  const intent = getSmartGitHubSubmitIntent(input)
  if (!intent) {
    throw new Error(`expected a GitHub intent for ${input}`)
  }
  return intent
}

describe('getUnresolvedSmartGitHubSubmitMessage', () => {
  it('names a pasted github.com issue without the default host', () => {
    expect(
      getUnresolvedSmartGitHubSubmitMessage(
        intentFor('https://github.com/org/app-client-a/issues/144'),
        true
      )
    ).toBe(
      'Could not load org/app-client-a#144. Check that it exists, that you can access it, and that it belongs to the origin or upstream repository of the selected project.'
    )
  })

  it('names pull request links the same way', () => {
    expect(
      getUnresolvedSmartGitHubSubmitMessage(intentFor('https://github.com/org/other/pull/9'), true)
    ).toContain('Could not load org/other#9.')
  })

  it('keeps the GitHub Enterprise host so the repository is unambiguous', () => {
    expect(
      getUnresolvedSmartGitHubSubmitMessage(
        {
          kind: 'link',
          host: 'ghe.example.com',
          owner: 'org',
          repo: 'app',
          number: 3,
          type: 'issue'
        },
        true
      )
    ).toContain('Could not load ghe.example.com/org/app#3.')
  })

  it('keeps the generic message for #number lookups', () => {
    expect(getUnresolvedSmartGitHubSubmitMessage(intentFor('#7'), true)).toBe(GENERIC)
  })

  it('keeps the generic message when no single git project was looked up', () => {
    // Project groups search several repositories; folder projects never run the lookup.
    expect(
      getUnresolvedSmartGitHubSubmitMessage(intentFor('https://github.com/org/app/issues/1'), false)
    ).toBe(GENERIC)
  })
})
