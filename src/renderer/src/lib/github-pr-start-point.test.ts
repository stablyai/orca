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

  it('throws resolver errors so submit can abort before creating from the wrong base', async () => {
    vi.mocked(window.api.worktrees.resolvePrBase).mockResolvedValue({
      error: 'Could not resolve PR head.'
    })

    await expect(
      resolveGitHubPrStartPointForRepo({
        repoId: 'repo-1',
        prNumber: 99,
        target: { kind: 'local' }
      })
    ).rejects.toThrow('Could not resolve PR head.')
  })

  it('marks creating from a PR as a user act, locally and on a paired host (E9)', async () => {
    const startPoint = { baseBranch: 'origin/main' }
    vi.mocked(window.api.worktrees.resolvePrBase).mockResolvedValue(startPoint)
    vi.mocked(callRuntimeRpc).mockResolvedValue(startPoint)

    await resolveGitHubPrStartPointForRepo({
      repoId: 'repo-1',
      prNumber: 7,
      target: { kind: 'local' }
    })
    await resolveGitHubPrStartPointForRepo({
      repoId: 'repo-1',
      prNumber: 7,
      target: { kind: 'environment', environmentId: 'env-1' }
    })

    expect(window.api.worktrees.resolvePrBase).toHaveBeenCalledWith(
      expect.objectContaining({ wakeWslDistro: true })
    )
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      expect.anything(),
      'worktree.resolvePrBase',
      expect.objectContaining({ wakeWslDistro: true }),
      expect.anything()
    )
  })
})
