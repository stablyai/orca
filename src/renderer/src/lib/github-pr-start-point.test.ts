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
})
