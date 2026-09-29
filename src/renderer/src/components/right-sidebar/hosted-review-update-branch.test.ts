import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { updateGitHubHostedReviewBranch } from './hosted-review-github-actions'

const mocks = vi.hoisted(() => ({ call: vi.fn(), capability: vi.fn(), local: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.call,
  assertRuntimeEnvironmentCapability: mocks.capability
}))

const repo: Repo = { id: 'repo-1', path: '/repo', displayName: 'repo', badgeColor: '', addedAt: 0 }
const args = {
  repo,
  prNumber: 42,
  prRepo: { owner: 'upstream', repo: 'project' },
  expectedHeadSha: 'a'.repeat(40)
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('window', { api: { gh: { updatePRBranch: mocks.local } } })
  mocks.call.mockResolvedValue({ ok: true })
  mocks.local.mockResolvedValue({ ok: true })
})

describe('updateGitHubHostedReviewBranch routing', () => {
  it('uses desktop IPC for local and SSH repositories', async () => {
    await updateGitHubHostedReviewBranch({ ...args, repo: { ...repo, connectionId: 'ssh-1' } })
    expect(mocks.local).toHaveBeenCalledWith({
      repoId: repo.id,
      repoPath: repo.path,
      prNumber: 42,
      prRepo: args.prRepo,
      expectedHeadSha: args.expectedHeadSha
    })
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('sends paired-runtime updates to the owning host with the expected head', async () => {
    await updateGitHubHostedReviewBranch({
      ...args,
      repo: { ...repo, executionHostId: 'runtime:remote-1' }
    })
    expect(mocks.capability).toHaveBeenCalledWith(
      'remote-1',
      'github.updatePRBranch',
      expect.any(String)
    )
    expect(mocks.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'remote-1' },
      'github.updatePRBranch',
      { repo: repo.id, prNumber: 42, prRepo: args.prRepo, expectedHeadSha: args.expectedHeadSha },
      { timeoutMs: 30_000 }
    )
    expect(mocks.local).not.toHaveBeenCalled()
  })

  it('does not fall back to a local mutation when the paired host is too old', async () => {
    mocks.capability.mockRejectedValue(new Error('Update the server'))
    await expect(
      updateGitHubHostedReviewBranch({
        ...args,
        repo: { ...repo, executionHostId: 'runtime:remote-1' }
      })
    ).rejects.toThrow('Update the server')
    expect(mocks.call).not.toHaveBeenCalled()
    expect(mocks.local).not.toHaveBeenCalled()
  })
})
