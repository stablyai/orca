import { describe, expect, it } from 'vitest'
import type { GitLabWorkItem } from '../../../shared/gitlab-types'
import {
  aggregateGitLabMultiProjectResults,
  type GitLabProjectFetchResult
} from './task-page-gitlab-multi-project'

function item(overrides: Partial<GitLabWorkItem> & Pick<GitLabWorkItem, 'number' | 'title'>): GitLabWorkItem {
  return {
    id: overrides.number,
    repoId: overrides.repoId ?? 'repo',
    type: 'mr',
    number: overrides.number,
    title: overrides.title,
    state: 'opened',
    url: `https://gitlab.example.com/team/app/-/merge_requests/${overrides.number}`,
    author: 'dev',
    updatedAt: overrides.updatedAt ?? '2026-05-08T00:00:00Z',
    ...overrides
  }
}

describe('aggregateGitLabMultiProjectResults / STA-3902', () => {
  it('keeps healthy project rows when a migrated peer is not_found', () => {
    // Why: "All projects" with one still-GitLab repo and one migrated-off-GitLab
    // repo must show the healthy project's MRs instead of the soft miss.
    const results: GitLabProjectFetchResult[] = [
      {
        repoId: 'still-gitlab',
        items: [item({ number: 3, title: 'ship it', repoId: 'still-gitlab' })]
      },
      {
        repoId: 'migrated-off-gitlab',
        items: [],
        error: {
          type: 'not_found',
          message: 'No GitLab project found for this repository.'
        }
      }
    ]

    const aggregate = aggregateGitLabMultiProjectResults(results)
    expect(aggregate.items.map((row) => row.title)).toEqual(['ship it'])
    expect(aggregate.bannerError).toBeNull()
    expect(aggregate.skippedNotFoundCount).toBe(1)
    expect(aggregate.failedCount).toBe(0)
    expect(aggregate.successCount).toBe(1)
  })

  it('does not replace the multi-project view with a soft not_found when every peer is empty', () => {
    // Why: pre-fix, a cwd-fallback glab failure classified as `unknown` with
    // raw stderr replaced the whole view even when peers only returned empty
    // lists. Soft not_found must yield the empty state, not a banner.
    const results: GitLabProjectFetchResult[] = [
      { repoId: 'still-gitlab', items: [] },
      {
        repoId: 'migrated-off-gitlab',
        items: [],
        error: {
          type: 'not_found',
          message: 'No GitLab project found for this repository.'
        }
      }
    ]

    const aggregate = aggregateGitLabMultiProjectResults(results)
    expect(aggregate.items).toEqual([])
    expect(aggregate.bannerError).toBeNull()
    expect(aggregate.skippedNotFoundCount).toBe(1)
    expect(aggregate.successCount).toBe(1)
  })

  it('still banners when every project hard-fails and nothing rendered', () => {
    const results: GitLabProjectFetchResult[] = [
      {
        repoId: 'a',
        items: [],
        error: { type: 'permission_denied', message: 'no permission for a' }
      },
      {
        repoId: 'b',
        items: [],
        error: { type: 'network_error', message: 'network down for b' }
      }
    ]

    const aggregate = aggregateGitLabMultiProjectResults(results)
    expect(aggregate.bannerError).toBe('no permission for a')
    expect(aggregate.failedCount).toBe(2)
    expect(aggregate.successCount).toBe(0)
  })

  it('keeps rendered rows when one project hard-fails and another succeeds', () => {
    const results: GitLabProjectFetchResult[] = [
      {
        repoId: 'ok',
        items: [item({ number: 1, title: 'ok mr', repoId: 'ok', updatedAt: '2026-05-09T00:00:00Z' })]
      },
      {
        repoId: 'denied',
        items: [],
        error: { type: 'permission_denied', message: 'no permission' }
      }
    ]

    const aggregate = aggregateGitLabMultiProjectResults(results)
    expect(aggregate.items.map((row) => row.title)).toEqual(['ok mr'])
    expect(aggregate.bannerError).toBeNull()
    expect(aggregate.failedCount).toBe(1)
    expect(aggregate.hardErrors).toEqual(['no permission'])
  })

  it('does not let a raw glab host-mismatch unknown error blank a healthy peer', () => {
    // Why: the original #13817 banner text came from classifyListIssuesError
    // fallthrough to `unknown` with the full glab stderr. Even if that still
    // reaches aggregation, a peer with items must win.
    const glabStderr =
      'Command failed: glab mr list --output json\n' +
      'ERROR None of the git remotes configured for this repository correspond to the GITLAB_HOST environment variable.\n' +
      'GITLAB_HOST is currently set to gitlab.example.com\n' +
      'Configured remotes: 10.0.0.5.'
    const results: GitLabProjectFetchResult[] = [
      {
        repoId: 'still-gitlab',
        items: [item({ number: 9, title: 'healthy', repoId: 'still-gitlab' })]
      },
      {
        repoId: 'migrated',
        items: [],
        error: { type: 'unknown', message: `Failed to load issues: ${glabStderr}` }
      }
    ]

    const aggregate = aggregateGitLabMultiProjectResults(results)
    expect(aggregate.items).toHaveLength(1)
    expect(aggregate.bannerError).toBeNull()
    expect(aggregate.failedCount).toBe(1)
  })
})
