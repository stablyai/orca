import { describe, expect, it } from 'vitest'
import { resolvePersistedGitHubIssueSourcePreference } from './github-issue-source-preference'

describe('resolvePersistedGitHubIssueSourcePreference', () => {
  it('keeps an explicit item source over the repo source', () => {
    expect(resolvePersistedGitHubIssueSourcePreference('origin', 'upstream')).toBe('origin')
  })

  it('falls back to the explicit repo source when the item has none', () => {
    expect(resolvePersistedGitHubIssueSourcePreference(null, 'upstream')).toBe('upstream')
  })

  it('treats auto as no persisted source', () => {
    expect(resolvePersistedGitHubIssueSourcePreference(undefined, 'auto')).toBeUndefined()
  })
})
