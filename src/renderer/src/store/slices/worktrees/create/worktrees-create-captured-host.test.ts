import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'

import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  mockApi,
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

describe('pin new workspaces', () => {
  it.each([false, true])(
    'persists the preference for a UI create (enabled: %s)',
    async (enabled) => {
      const store = createTestStore()
      store.setState({
        settings: { ...getDefaultSettings('/tmp'), pinNewWorkspaces: enabled },
        repos: [],
        worktreesByRepo: { repo1: [] }
      })
      mockApi.worktrees.create.mockResolvedValue({
        worktree: makeWorktree({ id: 'repo1::/path/feature', repoId: 'repo1' })
      })

      const createWorktree = store.getState().createWorktree
      const args: Parameters<typeof createWorktree> = ['repo1', 'feature']
      args[25] = { executionHostId: 'local' }
      const result = await createWorktree(...args)

      if (enabled) {
        expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
          worktreeId: 'repo1::/path/feature',
          executionHostId: 'local',
          updates: { isPinned: true }
        })
        expect(result.worktree.isPinned).toBe(true)
      } else {
        expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
        expect(result.worktree.isPinned).toBe(false)
      }
    }
  )
})

it('sends the pin intent to the captured remote host before creation', async () => {
  const store = createTestStore()
  store.setState({
    settings: { ...getDefaultSettings('/tmp'), pinNewWorkspaces: true },
    repos: [],
    worktreesByRepo: { repo1: [] }
  })
  runtimeEnvironmentCall.mockResolvedValue({
    id: 'create',
    ok: true,
    result: {
      worktree: makeWorktree({ id: 'repo1::/path/feature', repoId: 'repo1', isPinned: true })
    },
    _meta: { runtimeId: 'runtime-remote' }
  })
  const createWorktree = store.getState().createWorktree
  const args: Parameters<typeof createWorktree> = ['repo1', 'feature']
  args[25] = { executionHostId: 'runtime:env-1' }

  const result = await createWorktree(...args)

  expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
    expect.objectContaining({
      method: 'worktree.create',
      params: expect.objectContaining({ pinOnCreate: true })
    })
  )
  expect(result.worktree.isPinned).toBe(true)
})

it('reports a failed older-host pin without failing workspace creation', async () => {
  const store = createTestStore()
  store.setState({
    settings: { ...getDefaultSettings('/tmp'), pinNewWorkspaces: true },
    repos: [],
    worktreesByRepo: { repo1: [] },
    updateWorktreeMeta: vi.fn().mockResolvedValue({ ok: false, error: 'offline' })
  })
  runtimeEnvironmentCall.mockResolvedValue({
    id: 'create',
    ok: true,
    result: { worktree: makeWorktree({ id: 'repo1::/path/feature', repoId: 'repo1' }) },
    _meta: { runtimeId: 'runtime-remote' }
  })
  const createWorktree = store.getState().createWorktree
  const args: Parameters<typeof createWorktree> = ['repo1', 'feature']
  args[25] = { executionHostId: 'runtime:env-1' }
  const result = await createWorktree(...args)
  expect(result.worktree.isPinned).toBe(false)
  expect(store.getState().updateWorktreeMeta).toHaveBeenCalledWith(
    'repo1::/path/feature',
    { isPinned: true },
    { executionHostId: 'runtime:env-1' }
  )
  const { toast } = await import('sonner')
  expect(toast.warning).toHaveBeenCalledWith('The workspace was created, but could not be pinned.')
})
