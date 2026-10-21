import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from './worktrees-slice-test-harness'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  resetWorktreeSliceModuleMemory()
})

describe('background creation host capture', () => {
  it.each<ExecutionHostId>(['local', 'ssh:remote-1', 'runtime:env-1'])(
    'keeps %s as the owner after focus moves to another runtime',
    async (executionHostId) => {
      const store = createTestStore()
      const worktree = makeWorktree({
        id: 'repo1::/path/feature',
        repoId: 'repo1',
        path: '/path/feature'
      })
      mockApi.worktrees.create.mockResolvedValue({ worktree })
      runtimeEnvironmentCall.mockResolvedValue({
        id: 'create',
        ok: true,
        result: { worktree },
        _meta: { runtimeId: 'runtime-remote' }
      })
      store.setState({
        settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'env-other' },
        repos: [],
        worktreesByRepo: { repo1: [] }
      })
      const createWorktree = store.getState().createWorktree
      const args: Parameters<typeof createWorktree> = ['repo1', 'feature']
      const options = { executionHostId, nameWasGenerated: false }
      args[25] = options
      await createWorktree(...args)
      if (executionHostId === 'runtime:env-1') {
        expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
          expect.objectContaining({
            selector: 'env-1',
            method: 'worktree.create'
          })
        )
        expect(mockApi.worktrees.create).not.toHaveBeenCalled()
        expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
          hostId: executionHostId,
          runtimeOwnerEnvironmentId: 'env-1'
        })
      } else {
        expect(mockApi.worktrees.create).toHaveBeenCalledOnce()
        expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
        expect(store.getState().worktreesByRepo.repo1[0].runtimeOwnerEnvironmentId).toBeUndefined()
      }
    }
  )
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

  // #18097: the unresolved-owner sentinel must not ride the direct-SSH fallback onto this machine.
  it('refuses a create whose captured owner is the unresolved-owner sentinel', async () => {
    const store = createTestStore()
    store.setState({ repos: [], worktreesByRepo: { repo1: [] } })
    const createWorktree = store.getState().createWorktree
    const args: Parameters<typeof createWorktree> = ['repo1', 'feature']
    args[25] = { executionHostId: 'runtime:unresolved-owner' }

    await expect(createWorktree(...args)).rejects.toThrow('The workspace host is unresolved')
    expect(mockApi.worktrees.create).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })
})
