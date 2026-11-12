import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: runtime.call
}))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: vi.fn()
}))

import {
  fetchGitLabMRDetailsForChecks,
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
      type: 'mr',
      includeReviewDetails: false
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
      expect.objectContaining({
        repo: 'id:repo-1',
        iid: 17,
        type: 'mr',
        includeReviewDetails: false
      }),
      { timeoutMs: 30_000 }
    )
  })
})
