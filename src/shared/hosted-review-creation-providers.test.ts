import { describe, expect, it } from 'vitest'
import {
  resolveHostedReviewCreationProvider,
  supportsHostedReviewCreation
} from './hosted-review-creation-providers'

describe('hosted review creation providers', () => {
  // The create-review blocker uses this list; missing implemented providers would remain unsupported in the UI.
  it('accepts every provider Orca can create a review on', () => {
    for (const provider of ['github', 'gitlab', 'bitbucket', 'azure-devops', 'gitea'] as const) {
      expect(supportsHostedReviewCreation(provider)).toBe(true)
      expect(resolveHostedReviewCreationProvider(provider)).toBe(provider)
    }
  })

  it('rejects unsupported and missing providers, falling back to GitHub copy', () => {
    expect(supportsHostedReviewCreation('unsupported')).toBe(false)
    expect(supportsHostedReviewCreation(null)).toBe(false)
    expect(supportsHostedReviewCreation(undefined)).toBe(false)
    expect(resolveHostedReviewCreationProvider('unsupported')).toBe('github')
  })
})
