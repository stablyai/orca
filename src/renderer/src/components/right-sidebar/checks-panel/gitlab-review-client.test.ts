import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitLabWorkItemDetails } from '../../../../../shared/gitlab-types'

const runtime = vi.hoisted(() => ({
  target: { kind: 'environment', environmentId: 'runtime-1' },
  call: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => runtime.target,
  callRuntimeRpc: runtime.call
}))

import {
  fetchGitLabMRDetailsForChecks,
  gitLabMRCommentsToPRComments,
  resolveGitLabMRDiscussionForChecks
} from './gitlab-review-client'

type AdapterSettings = Parameters<typeof fetchGitLabMRDetailsForChecks>[0]['settings']

beforeEach(() => {
  runtime.call.mockReset()
  runtime.call.mockResolvedValue(null)
})

describe('GitLab checks-panel provider adapter', () => {
  it('uses the runtime owner, provider-neutral payload, and 30 second timeout', async () => {
    const settings = {} as AdapterSettings

    await fetchGitLabMRDetailsForChecks({
      repoPath: '/workspace/repo',
      repoId: 'repo-1',
      settings,
      iid: 17
    })
    await resolveGitLabMRDiscussionForChecks({
      repoPath: '/workspace/repo',
      repoId: 'repo-1',
      settings,
      iid: 17,
      discussionId: 'discussion-4',
      resolved: true
    })

    expect(runtime.call).toHaveBeenNthCalledWith(
      1,
      runtime.target,
      'gitlab.workItemDetails',
      { repo: 'repo-1', iid: 17, type: 'mr' },
      { timeoutMs: 30_000 }
    )
    expect(runtime.call).toHaveBeenNthCalledWith(
      2,
      runtime.target,
      'gitlab.resolveMRDiscussion',
      {
        repo: 'repo-1',
        iid: 17,
        discussionId: 'discussion-4',
        resolved: true
      },
      { timeoutMs: 30_000 }
    )
  })

  it('removes open-ended GitLab reactions before rendering shared comments', () => {
    const comments: GitLabWorkItemDetails['comments'] = [
      {
        id: 9,
        author: 'reviewer',
        authorAvatarUrl: 'https://gitlab.example/avatar.png',
        body: 'Please update this.',
        createdAt: '2026-01-01T00:00:00Z',
        url: 'https://gitlab.example/comment/9',
        reactions: [{ name: 'custom-award', count: 2 }]
      }
    ]

    expect(gitLabMRCommentsToPRComments(comments)).toEqual([
      {
        id: 9,
        author: 'reviewer',
        authorAvatarUrl: 'https://gitlab.example/avatar.png',
        body: 'Please update this.',
        createdAt: '2026-01-01T00:00:00Z',
        url: 'https://gitlab.example/comment/9'
      }
    ])
  })
})
