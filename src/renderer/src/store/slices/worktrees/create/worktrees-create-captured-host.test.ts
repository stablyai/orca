import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../../shared/constants'

import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall
} from '../worktrees-slice-test-harness'
import { createCompatibleRuntimeStatusResponse } from '../../../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { createWorktreeOnRuntimeHost } from './host-planned-agent-launch'
import { WorktreeCreate } from '../../../../../../shared/rpc-contract/worktree-create-params'
import { buildManagedWorktreeCreateArgs } from '../../../../../../main/runtime/rpc/methods/workspaces/worktree-create-args'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  resetWorktreeSliceModuleMemory()
})

it.each([true, false])(
  'delivers effort deletion only to a capable creation owner (%s)',
  async (supported) => {
    const status = createCompatibleRuntimeStatusResponse('destination-7')
    if (!supported) {
      status.result.capabilities = status.result.capabilities?.filter(
        (capability) => capability !== 'agent.launch.terminal-option-edits.v1'
      )
    }
    runtimeEnvironmentTransportCall.mockImplementation((args) =>
      args.method === 'status.get' ? status : runtimeEnvironmentCall(args)
    )
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'create',
      ok: true,
      result: { worktree: makeWorktree({ id: 'repo1::/path/feature', repoId: 'repo1' }) }
    })
    await createWorktreeOnRuntimeHost(
      'env-1',
      {
        repoId: 'repo1',
        name: 'feature',
        options: {
          creationAgentLaunch: {
            agent: 'antigravity',
            inputs: { terminalOptionEdits: { effort: null } }
          }
        }
      },
      { name: 'feature' },
      {}
    )
    const dispatch = runtimeEnvironmentTransportCall.mock.calls.find(
      ([args]) => args.method === 'worktree.create'
    )?.[0]
    expect(dispatch).toMatchObject({ method: 'worktree.create' })
    const parsed = WorktreeCreate.parse(dispatch?.params)
    const managed = buildManagedWorktreeCreateArgs(parsed, {})
    expect(managed.startupAgent).toBe('antigravity')
    if (supported) {
      expect(dispatch).toMatchObject({ expectedEnvironmentRuntimeId: 'destination-7' })
      expect(managed.startupTerminalOptionEdits).toEqual({ effort: null })
    } else {
      expect(dispatch?.params).not.toHaveProperty('startupTerminalOptionEdits')
      expect(managed.startupTerminalOptionEdits).toBeUndefined()
    }
  }
)

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
