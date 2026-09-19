import { describe, expect, it } from 'vitest'

import { resolveWorkspaceIssueReferenceTarget } from './workspace-issue-reference-target'

describe('resolveWorkspaceIssueReferenceTarget', () => {
  it('reads the provider and host off the linked work item', () => {
    expect(
      resolveWorkspaceIssueReferenceTarget({
        linkedWorkItem: {
          provider: 'gitlab',
          type: 'issue',
          number: 7,
          title: 't',
          url: 'https://gitlab.acme.internal/g/sub/app/-/issues/7'
        }
      })
    ).toEqual({ provider: 'gitlab', slug: { host: 'gitlab.acme.internal', path: 'g/sub/app' } })

    expect(
      resolveWorkspaceIssueReferenceTarget({
        linkedWorkItem: {
          provider: 'github',
          type: 'issue',
          number: 7,
          title: 't',
          url: 'https://github.acme.internal/acme/app/issues/7'
        }
      })
    ).toEqual({
      provider: 'github',
      slug: { owner: 'acme', repo: 'app', host: 'github.acme.internal' }
    })
  })

  it('falls back to the linked review URL', () => {
    expect(
      resolveWorkspaceIssueReferenceTarget({
        reviewProvider: 'gitlab',
        reviewUrl: 'https://gitlab.com/g/app/-/merge_requests/3'
      })
    ).toEqual({ provider: 'gitlab', slug: { host: 'gitlab.com', path: 'g/app' } })
  })

  it('returns null when nothing names a host', () => {
    expect(resolveWorkspaceIssueReferenceTarget({})).toBeNull()
    expect(
      resolveWorkspaceIssueReferenceTarget({
        linkedWorkItem: {
          provider: 'jira',
          type: 'issue',
          number: 1,
          title: 't',
          url: 'https://x.atlassian.net/browse/A-1'
        }
      })
    ).toBeNull()
    // A bare number with no URL anywhere cannot name a host — plain text, not a guess.
    expect(
      resolveWorkspaceIssueReferenceTarget({ reviewProvider: 'gitlab', reviewUrl: null })
    ).toBeNull()
  })
})
