import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GITLAB_MR_APPROVAL_UPDATE_REQUIRED_MESSAGE } from '../../../../shared/protocol-version'

const { callRuntimeResult, getRemoteRuntimeStatus } = vi.hoisted(() => ({
  callRuntimeResult: vi.fn(),
  getRemoteRuntimeStatus: vi.fn()
}))

vi.mock('./web-runtime-calls', () => ({ callRuntimeResult, getRemoteRuntimeStatus }))

import { createGitLabApi } from './web-gitlab-api'

describe('web GitLab API routing', () => {
  beforeEach(() => {
    callRuntimeResult.mockReset().mockResolvedValue(null)
    getRemoteRuntimeStatus.mockReset()
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

  it('refuses approval when the runtime lacks the approval capability', async () => {
    getRemoteRuntimeStatus.mockResolvedValue({ capabilities: [] })
    await expect(
      createGitLabApi().updateMR({
        repoPath: '/r',
        repoId: 'repo-1',
        iid: 7,
        updates: { approval: 'approve' }
      })
    ).resolves.toEqual({ ok: false, error: GITLAB_MR_APPROVAL_UPDATE_REQUIRED_MESSAGE })
    expect(callRuntimeResult).not.toHaveBeenCalled()
  })

  it('refuses approval when the runtime status read fails', async () => {
    getRemoteRuntimeStatus.mockRejectedValue(new Error('offline'))
    await expect(
      createGitLabApi().updateMR({
        repoPath: '/r',
        repoId: 'repo-1',
        iid: 7,
        updates: { approval: 'unapprove' }
      })
    ).resolves.toEqual({ ok: false, error: GITLAB_MR_APPROVAL_UPDATE_REQUIRED_MESSAGE })
    expect(callRuntimeResult).not.toHaveBeenCalled()
  })

  it('routes approval when the runtime advertises the capability', async () => {
    getRemoteRuntimeStatus.mockResolvedValue({ capabilities: ['gitlab.updateMR.approval.v1'] })
    await createGitLabApi().updateMR({
      repoPath: '/r',
      repoId: 'repo-1',
      iid: 7,
      updates: { approval: 'approve' }
    })
    expect(callRuntimeResult).toHaveBeenCalledWith(
      'gitlab.updateMR',
      expect.objectContaining({ iid: 7, updates: { approval: 'approve' } })
    )
  })
})
