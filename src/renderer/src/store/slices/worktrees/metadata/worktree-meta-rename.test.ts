import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import 'sonner'
import type { RuntimeEnvironmentCallRequest } from '../../../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { createCompatibleRuntimeStatusResponse } from '../../../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { WORKTREE_RENAME_ERROR_DISMISS_RUNTIME_CAPABILITY } from '../../../../../../shared/worktree-runtime-capabilities'
import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall
} from '../worktrees-slice-test-harness'

const requestWorktreeBaseFallbackNotice = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice
}))

beforeEach(resetWorktreeSliceModuleMemory)

describe('worktree remote runtime mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('dismisses a rename error on its capable remote owner', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      hostId: 'runtime:env-1',
      firstAgentMessageRenameError: 'Name agent failed'
    })
    store.setState({ worktreesByRepo: { repo1: [wt] } })
    const status = createCompatibleRuntimeStatusResponse()
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
      args.method === 'status.get' ? status : runtimeEnvironmentCall(args)
    )
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'clear',
      ok: true,
      result: { worktree: { ...wt, firstAgentMessageRenameError: null } }
    })

    const result = await store
      .getState()
      .updateWorktreeMeta(
        wt.id,
        { firstAgentMessageRenameError: null },
        { executionHostId: 'runtime:env-1' }
      )

    expect(result).toEqual({ ok: true })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'worktree.set',
        params: { worktree: `id:${wt.id}`, firstAgentMessageRenameError: null }
      })
    )
    expect(store.getState().worktreesByRepo.repo1[0]?.firstAgentMessageRenameError).toBeNull()
  })

  it('refuses rename error dismissal without owner capability', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      hostId: 'runtime:env-1',
      firstAgentMessageRenameError: 'Name agent failed'
    })
    store.setState({ worktreesByRepo: { repo1: [wt] } })
    const status = createCompatibleRuntimeStatusResponse()
    status.result.capabilities = status.result.capabilities?.filter(
      (capability) => capability !== WORKTREE_RENAME_ERROR_DISMISS_RUNTIME_CAPABILITY
    )
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
      args.method === 'status.get' ? status : runtimeEnvironmentCall(args)
    )
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'clear',
      ok: true,
      result: { worktree: { ...wt, firstAgentMessageRenameError: null } }
    })

    const result = await store
      .getState()
      .updateWorktreeMeta(
        wt.id,
        { firstAgentMessageRenameError: null },
        { executionHostId: 'runtime:env-1' }
      )

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('Update the remote runtime')
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'worktree.set' })
    )
  })

  it('clears pending first-agent rename when the title is updated', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      displayName: 'Nautilus',
      pendingFirstAgentMessageRename: true
    })
    store.setState({
      worktreesByRepo: { repo1: [wt] }
    } as Partial<AppState>)

    await store.getState().updateWorktreeMeta(wt.id, { displayName: 'Fix auth' })

    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      executionHostId: 'local',
      updates: {
        displayName: 'Fix auth',
        displayNameIsPinned: true,
        pendingFirstAgentMessageRename: false,
        firstAgentMessageRenameError: null
      }
    })
    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      displayName: 'Fix auth',
      pendingFirstAgentMessageRename: false,
      firstAgentMessageRenameError: null
    })
  })
})
