import { describe, expect, it } from 'vitest'
import type { HostedReviewProvider } from '../../../../shared/hosted-review'
import { resolveCreatedHostedReviewLink } from './source-control-created-review-link'

describe('resolveCreatedHostedReviewLink', () => {
  it.each([
    ['github', { linkedPR: 42 }, { linkedGitHubPR: 42 }],
    ['gitlab', { linkedGitLabMR: 42 }, { linkedGitLabMR: 42 }],
    ['bitbucket', { linkedBitbucketPR: 42 }, { linkedBitbucketPR: 42 }],
    ['azure-devops', { linkedAzureDevOpsPR: 42 }, { linkedAzureDevOpsPR: 42 }],
    ['gitea', { linkedGiteaPR: 42 }, { linkedGiteaPR: 42 }]
  ] as const)('links a created %s review by number', (provider, worktree, lookup) => {
    expect(resolveCreatedHostedReviewLink(provider as HostedReviewProvider, 42)).toEqual({
      worktree,
      lookup
    })
  })

  it('does not link an unsupported review provider', () => {
    expect(resolveCreatedHostedReviewLink('unsupported', 42)).toEqual({
      worktree: {},
      lookup: {}
    })
  })
})
