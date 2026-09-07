import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeResult = vi.hoisted(() => vi.fn())

vi.mock('./web-runtime-calls', () => ({ callRuntimeResult }))

import { createGitLabApi } from './web-gitlab-api'

describe('web GitLab API routing', () => {
  beforeEach(() => {
    callRuntimeResult.mockReset().mockResolvedValue(null)
  })

  it('does not forward the desktop repo-owner guard over runtime RPC', async () => {
    await createGitLabApi().workItemDetails({
      repoPath: '/workspace/repo',
      repoId: 'repo-1',
      repoOwnerExecutionHostId: 'ssh:ssh-1',
      iid: 42,
      type: 'mr'
    })

    expect(callRuntimeResult).toHaveBeenCalledWith('gitlab.workItemDetails', {
      repo: 'id:repo-1',
      repoId: 'repo-1',
      repoPath: '/workspace/repo',
      iid: 42,
      type: 'mr'
    })
  })
})
