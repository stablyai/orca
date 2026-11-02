import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import { admitSourceControlRecovery } from './source-control-recovery-admission'
import { deferred } from './source-control-hook-test-harness'

const mocks = vi.hoisted(() => ({ probe: vi.fn(), toastError: vi.fn() }))
vi.mock('@/runtime/runtime-git-status-client', () => ({
  getRuntimeGitMutationInFlight: mocks.probe
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

const context: RuntimeGitContext = {
  target: { kind: 'environment', environmentId: 'host-a' },
  worktreeId: 'repo::/repo',
  worktreePath: '/repo'
}

describe('source-control recovery admission', () => {
  beforeEach(() => {
    mocks.probe.mockReset().mockResolvedValue({ inFlight: false })
    mocks.toastError.mockReset()
  })

  it.each([false, true, 'unsupported'] as const)(
    'ignores a cancelled check returning %s',
    async (result) => {
      const check = deferred<{ inFlight: boolean }>()
      mocks.probe.mockReturnValueOnce(check.promise)
      const controller = new AbortController()
      const admission = admitSourceControlRecovery(context, controller.signal)
      controller.abort()
      if (result === 'unsupported') {
        check.reject(new Error('method_not_found'))
      } else {
        check.resolve({ inFlight: result })
      }
      await expect(admission).resolves.toBe(false)
      expect(mocks.toastError).not.toHaveBeenCalled()
    }
  )
})
