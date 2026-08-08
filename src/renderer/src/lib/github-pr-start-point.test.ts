import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import { resolveGitHubPrStartPointForRepo } from './github-pr-start-point'

vi.mock('@/runtime/runtime-rpc-client', async () => {
  const actual = await vi.importActual<typeof RuntimeRpcClient>('@/runtime/runtime-rpc-client')
  return {
    ...actual,
    callRuntimeRpc: vi.fn()
  }
})

describe('resolveGitHubPrStartPointForRepo', () => {
  beforeEach(() => {
    vi.mocked(callRuntimeRpc).mockReset()
    vi.stubGlobal('window', {
      api: {
        worktrees: {
          resolvePrBase: vi.fn()
        }
      }
    })
  })

  it('resolves local PR heads through worktree IPC with PR branch hints', async () => {
    vi.mocked(window.api.worktrees.resolvePrBase).mockResolvedValue({
      baseBranch: 'abc123',
      compareBaseRef: 'refs/remotes/origin/main',
      branchNameOverride: 'feature/fix',
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })

    await expect(
      resolveGitHubPrStartPointForRepo({
        repoId: 'repo-1',
        prNumber: 42,
        settings: { activeRuntimeEnvironmentId: null },
        headRefName: 'feature/fix',
        baseRefName: 'main',
        isCrossRepository: false
      })
    ).resolves.toMatchObject({
      baseBranch: 'abc123',
      branchNameOverride: 'feature/fix'
    })

    expect(window.api.worktrees.resolvePrBase).toHaveBeenCalledWith({
      repoId: 'repo-1',
      prNumber: 42,
      headRefName: 'feature/fix',
      baseRefName: 'main',
      isCrossRepository: false
    })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('routes runtime-owned PR head resolution through runtime RPC', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue({
      baseBranch: 'def456',
      compareBaseRef: 'refs/remotes/origin/develop',
      branchNameOverride: 'feature/runtime',
      pushTarget: { remoteName: 'fork', branchName: 'feature/runtime' }
    })

    await expect(
      resolveGitHubPrStartPointForRepo({
        repoId: 'repo-runtime',
        prNumber: 7,
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        headRefName: 'feature/runtime',
        baseRefName: 'develop',
        isCrossRepository: true
      })
    ).resolves.toMatchObject({
      baseBranch: 'def456',
      branchNameOverride: 'feature/runtime'
    })

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'worktree.resolvePrBase',
      {
        repo: 'repo-runtime',
        prNumber: 7,
        headRefName: 'feature/runtime',
        baseRefName: 'develop',
        isCrossRepository: true
      },
      { timeoutMs: 30_000 }
    )
    expect(window.api.worktrees.resolvePrBase).not.toHaveBeenCalled()
  })

  it('throws resolver errors so submit can abort before creating from the wrong base', async () => {
    vi.mocked(window.api.worktrees.resolvePrBase).mockResolvedValue({
      error: 'Could not resolve PR head.'
    })

    await expect(
      resolveGitHubPrStartPointForRepo({
        repoId: 'repo-1',
        prNumber: 99,
        settings: null
      })
    ).rejects.toThrow('Could not resolve PR head.')
  })
})
