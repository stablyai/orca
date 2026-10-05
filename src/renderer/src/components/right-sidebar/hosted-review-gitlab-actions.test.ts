// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { GITLAB_MR_APPROVAL_UPDATE_REQUIRED_MESSAGE } from '../../../../shared/protocol-version'

const runtimeRpcMocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  assertRuntimeEnvironmentCapability: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', () => runtimeRpcMocks)

import { setGitLabHostedReviewApproval } from './hosted-review-gitlab-actions'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'repo',
    badgeColor: '',
    addedAt: 0,
    ...overrides
  }
}

describe('setGitLabHostedReviewApproval', () => {
  const updateMR = vi.fn()
  beforeEach(() => {
    runtimeRpcMocks.callRuntimeRpc.mockReset().mockResolvedValue({ ok: true })
    runtimeRpcMocks.assertRuntimeEnvironmentCapability.mockReset().mockResolvedValue(undefined)
    updateMR.mockReset().mockResolvedValue({ ok: true })
    Object.defineProperty(window, 'api', { configurable: true, value: { gl: { updateMR } } })
  })

  it.each([{}, { connectionId: 'ssh-1' }])(
    'approves through local IPC for local and SSH repos',
    async (overrides) => {
      await setGitLabHostedReviewApproval({
        repo: makeRepo(overrides),
        mrNumber: 7,
        approval: 'approve'
      })
      expect(updateMR).toHaveBeenCalledWith({
        repoPath: '/repo',
        repoId: 'repo-1',
        iid: 7,
        updates: { approval: 'approve' }
      })
      expect(runtimeRpcMocks.callRuntimeRpc).not.toHaveBeenCalled()
    }
  )

  it('checks the capability then calls gitlab.updateMR on a remote runtime', async () => {
    await setGitLabHostedReviewApproval({
      repo: makeRepo({ executionHostId: 'runtime:env-1' }),
      mrNumber: 7,
      approval: 'unapprove'
    })
    expect(runtimeRpcMocks.assertRuntimeEnvironmentCapability).toHaveBeenCalledWith(
      'env-1',
      'gitlab.updateMR.approval.v1',
      GITLAB_MR_APPROVAL_UPDATE_REQUIRED_MESSAGE
    )
    expect(runtimeRpcMocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'gitlab.updateMR',
      { repo: 'repo-1', iid: 7, updates: { approval: 'unapprove' } },
      { timeoutMs: 30_000 }
    )
    expect(updateMR).not.toHaveBeenCalled()
  })

  it('never falls back to local IPC when the runtime lacks the capability', async () => {
    runtimeRpcMocks.assertRuntimeEnvironmentCapability.mockRejectedValue(
      new Error('update required')
    )
    await expect(
      setGitLabHostedReviewApproval({
        repo: makeRepo({ executionHostId: 'runtime:env-1' }),
        mrNumber: 7,
        approval: 'approve'
      })
    ).rejects.toThrow('update required')
    expect(runtimeRpcMocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(updateMR).not.toHaveBeenCalled()
  })
})
