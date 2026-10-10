import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitLabWorkItemDetails } from '../../../../../shared/gitlab-types'

const runtime = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: runtime.call,
  runtimeEnvironmentSupportsCapability: vi.fn()
}))

import {
  fetchGitLabMRDetailsForChecks,
  gitLabMRCommentsToPRComments,
  resolveGitLabMRDiscussionForChecks
} from './gitlab-review-client'

const gl = { workItemDetails: vi.fn(), resolveMRDiscussion: vi.fn() }

beforeEach(() => {
  runtime.call.mockReset()
  runtime.call.mockResolvedValue(null)
  gl.workItemDetails.mockReset().mockResolvedValue(null)
  gl.resolveMRDiscussion.mockReset().mockResolvedValue({ ok: true })
  vi.stubGlobal('window', { api: { gl } })
})

describe('GitLab checks-panel provider adapter', () => {
  it('reads an SSH workspace MR on this computer, never the focused server (#24264)', async () => {
    await fetchGitLabMRDetailsForChecks({
      repoPath: '/workspace/repo',
      repoId: 'repo-1',
      iid: 17,
      repoOwnerExecutionHostId: 'ssh:devbox'
    })
    await resolveGitLabMRDiscussionForChecks({
      repoPath: '/workspace/repo',
      repoId: 'repo-1',
      iid: 17,
      discussionId: 'discussion-4',
      resolved: true,
      repoOwnerExecutionHostId: 'ssh:devbox'
    })

    expect(runtime.call).not.toHaveBeenCalled()
    expect(gl.workItemDetails).toHaveBeenCalledWith({
      repoPath: '/workspace/repo',
      repoId: 'repo-1',
      repoOwnerExecutionHostId: 'ssh:devbox',
      iid: 17,
      type: 'mr'
    })
    expect(gl.resolveMRDiscussion).toHaveBeenCalledOnce()
  })

  it('reads a server-owned workspace MR on its owner with the 30 second timeout', async () => {
    await fetchGitLabMRDetailsForChecks({
      repoPath: '/workspace/repo',
      repoId: 'repo-1',
      iid: 17,
      repoOwnerExecutionHostId: 'runtime:owner-runtime'
    })

    expect(gl.workItemDetails).not.toHaveBeenCalled()
    expect(runtime.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'owner-runtime' },
      'gitlab.workItemDetails',
      expect.objectContaining({ repo: 'id:repo-1', iid: 17, type: 'mr' }),
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
