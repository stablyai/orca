import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../../runtime/runtime-rpc-client'
import { WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import { persistWorktreeMeta } from './worktree-meta-persist'

const mocks = vi.hoisted(() => ({
  assertCapability: vi.fn(),
  callRuntimeRpc: vi.fn(),
  supportsCapability: vi.fn(),
  target: { kind: 'environment', environmentId: 'env-1' } as RuntimeClientTarget
}))

vi.mock('../../../../runtime/runtime-rpc-client', () => ({
  assertRuntimeEnvironmentCapability: mocks.assertCapability,
  callRuntimeRpc: mocks.callRuntimeRpc,
  getActiveRuntimeTarget: () => mocks.target,
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('persistWorktreeMeta GitHub PR suppression compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.target = { kind: 'environment', environmentId: 'env-1' }
    mocks.assertCapability.mockResolvedValue(undefined)
    mocks.supportsCapability.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requires host support before sending a positive suppression write', async () => {
    mocks.assertCapability.mockRejectedValue(new Error('update required'))

    await expect(
      persistWorktreeMeta({} as never, 'repo::/feature', { suppressedGitHubPR: 42 })
    ).rejects.toThrow('update required')

    expect(mocks.assertCapability).toHaveBeenCalledWith(
      'env-1',
      WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY,
      'Update the remote runtime to unlink GitHub pull requests'
    )
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('sends positive suppression writes to capable hosts', async () => {
    await persistWorktreeMeta({} as never, 'repo::/feature', { suppressedGitHubPR: 42 })

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      mocks.target,
      'worktree.set',
      { worktree: 'id:repo::/feature', suppressedGitHubPR: 42 },
      { timeoutMs: 15_000 }
    )
  })

  it('strips null clears for older hosts while preserving compatible updates', async () => {
    mocks.supportsCapability.mockResolvedValue(false)

    await persistWorktreeMeta({} as never, 'repo::/feature', {
      linkedPR: 42,
      suppressedGitHubPR: null
    })

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      mocks.target,
      'worktree.set',
      { worktree: 'id:repo::/feature', linkedPR: 42 },
      { timeoutMs: 15_000 }
    )
  })

  it('keeps null clears for capable hosts', async () => {
    await persistWorktreeMeta({} as never, 'repo::/feature', {
      linkedPR: 42,
      suppressedGitHubPR: null
    })

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      mocks.target,
      'worktree.set',
      { worktree: 'id:repo::/feature', linkedPR: 42, suppressedGitHubPR: null },
      { timeoutMs: 15_000 }
    )
  })

  it('preserves host-owned suppression writes without a paired-runtime capability check', async () => {
    const updateMeta = vi.fn().mockResolvedValue(undefined)
    mocks.target = { kind: 'local' }
    vi.stubGlobal('window', { api: { worktrees: { updateMeta } } })

    await persistWorktreeMeta(
      {} as never,
      'repo::/feature',
      { suppressedGitHubPR: 42 },
      'ssh:build-box'
    )

    expect(updateMeta).toHaveBeenCalledWith({
      worktreeId: 'repo::/feature',
      executionHostId: 'ssh:build-box',
      updates: { suppressedGitHubPR: 42 }
    })
    expect(mocks.assertCapability).not.toHaveBeenCalled()
  })
})
