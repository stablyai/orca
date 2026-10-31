import { describe, expect, it } from 'vitest'
import { isGitHubPRSuppressed, normalizeGitHubPRSuppressionUpdate } from './github-pr-suppression'

describe('GitHub PR suppression', () => {
  it('suppresses only a matching discovered PR without an explicit link', () => {
    expect(isGitHubPRSuppressed({ linkedPR: null, suppressedGitHubPR: 42 }, 42)).toBe(true)
    expect(isGitHubPRSuppressed({ linkedPR: null, suppressedGitHubPR: 42 }, 43)).toBe(false)
  })

  it('lets an explicit GitHub PR link override stale suppression metadata', () => {
    expect(isGitHubPRSuppressed({ linkedPR: 42, suppressedGitHubPR: 42 }, 42)).toBe(false)
  })

  it('clears suppression in the same update that explicitly links a PR', () => {
    expect(normalizeGitHubPRSuppressionUpdate({ linkedPR: 42, suppressedGitHubPR: 7 })).toEqual({
      linkedPR: 42,
      suppressedGitHubPR: null
    })
    const clear = { linkedPR: null, suppressedGitHubPR: 42 }
    expect(normalizeGitHubPRSuppressionUpdate(clear)).toBe(clear)
  })
})
