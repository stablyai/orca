// An older host answers the web client's local-target call with method_not_found too; it must read
// as "update that host" (Continue) or unsupported (autoStash), never a generic failure to retry.
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeRpcCallError } from '../../rpc/calls/runtime-rpc-result'
import {
  continueRuntimeGitRebase,
  readRuntimeGitRebaseAutoStash
} from './runtime-git-rebase-client'

const missing = () =>
  new RuntimeRpcCallError({
    id: '1',
    ok: false,
    error: { code: 'method_not_found', message: 'Unknown method' }
  } as never)

afterEach(() => {
  vi.unstubAllGlobals()
})

it('translates a missing method on the local-target path', async () => {
  vi.stubGlobal('window', {
    api: {
      git: {
        continueRebase: vi.fn().mockRejectedValue(missing()),
        rebaseAutoStash: vi.fn().mockRejectedValue(missing())
      }
    }
  })
  const context = { target: { kind: 'local' as const }, worktreePath: '/repo' }
  await expect(continueRuntimeGitRebase(context, 'inspect')).resolves.toMatchObject({
    outcome: 'failed',
    message: expect.stringContaining('newer Orca')
  })
  await expect(readRuntimeGitRebaseAutoStash(context)).resolves.toBe('unsupported')
})
