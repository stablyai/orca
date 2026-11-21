import { describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '../../rpc/calls/runtime-rpc-result'
import { getRuntimeGitDiff } from './runtime-git-diff-client'

vi.mock('../../rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: vi.fn() }))

describe('remote git diff past the connection budget', () => {
  it('reads as a too-large diff instead of a load error', async () => {
    vi.mocked(callRuntimeRpc).mockRejectedValue(
      new RuntimeRpcCallError({
        id: 'diff',
        ok: false,
        error: {
          code: 'diff_too_large',
          message: 'This diff is too large to open over a remote connection.'
        }
      })
    )

    await expect(
      getRuntimeGitDiff(
        {
          target: { kind: 'environment', environmentId: 'server' },
          worktreeId: 'repo::/work/wt',
          worktreePath: '/work/wt'
        },
        { filePath: 'huge.json', staged: false }
      )
    ).resolves.toMatchObject({ kind: 'binary', tooLarge: true, tooLargeForConnection: true })
  })
})
