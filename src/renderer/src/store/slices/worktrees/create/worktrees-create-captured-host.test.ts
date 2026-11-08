import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../../shared/constants'

import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from '../worktrees-slice-test-harness'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  resetWorktreeSliceModuleMemory()
})

describe('background creation host capture', () => {
  it('retains the selected owner when focus changes while creation is running', async () => {
    const store = createTestStore()
    const response = Promise.withResolvers<unknown>()
    runtimeEnvironmentCall.mockReturnValue(response.promise)
    store.setState({
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'env-1' },
      repos: [],
      worktreesByRepo: { repo1: [] }
    })
    const createWorktree = store.getState().createWorktree
    const args: Parameters<typeof createWorktree> = ['repo1', 'feature']
    args[25] = { executionHostId: 'runtime:env-1' }
    const creating = createWorktree(...args)
    await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalled())
    store.setState({
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'env-other' }
    })
    response.resolve({
      id: 'create',
      ok: true,
      result: { worktree: makeWorktree({ id: 'repo1::/path/feature', repoId: 'repo1' }) },
      _meta: { runtimeId: 'runtime-remote' }
    })
    await creating
    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      hostId: 'runtime:env-1',
      runtimeOwnerEnvironmentId: 'env-1'
    })
  })
})
