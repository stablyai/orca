import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import {
  WORKTREE_LINKED_ITEMS_RUNTIME_CAPABILITY,
  WORKTREE_LINKED_ITEMS_DELTA_RUNTIME_CAPABILITY
} from '../../../../../../shared/workspace-attachments/workspace-attachment-capabilities'
import { persistWorktreeMeta } from './worktree-meta-persist'

const mocks = vi.hoisted(() => ({
  assertCapability: vi.fn(),
  callRuntimeRpc: vi.fn(),
  supportsCapability: vi.fn(),
  target: { kind: 'environment', environmentId: 'env-1' } as RuntimeClientTarget
}))

vi.mock('../../../../runtime/rpc/compatibility/runtime-capability-proof', () => ({
  assertRuntimeEnvironmentCapability: mocks.assertCapability,
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))
vi.mock('../../../../runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('persistWorktreeMeta GitHub PR suppression compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.target = { kind: 'environment', environmentId: 'env-1' }
    mocks.assertCapability.mockResolvedValue(undefined)
    mocks.supportsCapability.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requires host support before sending a positive suppression write', async () => {
    mocks.assertCapability.mockRejectedValue(new Error('update required'))

    await expect(
      persistWorktreeMeta(mocks.target, 'repo::/feature', { suppressedGitHubPR: 42 })
    ).rejects.toThrow('update required')

    expect(mocks.assertCapability).toHaveBeenCalledWith(
      'env-1',
      WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY,
      'Update the remote runtime to unlink GitHub pull requests'
    )
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('rejects attachment writes before an older host can silently drop them', async () => {
    mocks.assertCapability.mockRejectedValue(new Error('update required'))
    await expect(
      persistWorktreeMeta(mocks.target, 'repo::/feature', { linkedItems: [] })
    ).rejects.toThrow('update required')
    expect(mocks.assertCapability).toHaveBeenCalledWith(
      'env-1',
      WORKTREE_LINKED_ITEMS_RUNTIME_CAPABILITY,
      'Update the remote runtime to change workspace links'
    )
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('strips null clears for older hosts while preserving compatible updates', async () => {
    mocks.supportsCapability.mockResolvedValue(false)

    await persistWorktreeMeta(mocks.target, 'repo::/feature', {
      linkedPR: 42,
      suppressedGitHubPR: null
    })

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      mocks.target,
      'worktree.set',
      {
        worktree: 'id:repo::/feature',
        linkedPR: 42,
        linkedGitLabMR: null,
        linkedBitbucketPR: null,
        linkedAzureDevOpsPR: null,
        linkedGiteaPR: null
      },
      { timeoutMs: 15_000 }
    )
  })
  it('gates and forwards the atomic collection snapshot', async () => {
    await persistWorktreeMeta(mocks.target, 'repo::/feature', {
      linkedItems: [],
      linkedItemsBase: [],
      linkedItemsSelectionChanged: false
    })
    expect(mocks.assertCapability).toHaveBeenCalledWith(
      'env-1',
      WORKTREE_LINKED_ITEMS_DELTA_RUNTIME_CAPABILITY,
      'Update the remote runtime to safely change workspace links'
    )
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      mocks.target,
      'worktree.set',
      {
        worktree: 'id:repo::/feature',
        linkedItems: [],
        linkedItemsBase: [],
        linkedItemsSelectionChanged: false
      },
      { timeoutMs: 15_000 }
    )
    mocks.callRuntimeRpc.mockClear()
    mocks.assertCapability.mockRejectedValue(new Error('atomic support required'))
    await expect(
      persistWorktreeMeta(mocks.target, 'repo::/feature', {
        linkedItems: [],
        linkedItemsBase: [],
        linkedItemsSelectionChanged: false
      })
    ).rejects.toThrow('atomic support required')
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })
})
