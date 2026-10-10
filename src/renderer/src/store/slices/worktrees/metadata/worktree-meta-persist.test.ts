import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../../runtime/runtime-rpc-client'
import { WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import {
  WORKTREE_LINKED_ITEMS_RUNTIME_CAPABILITY,
  WORKTREE_LINKED_ITEMS_DELTA_RUNTIME_CAPABILITY
} from '../../../../../../shared/workspace-attachment-capabilities'
import { persistWorktreeMeta } from './worktree-meta-persist'
import { createGlobalSettingsFixture } from '../../../../../../shared/global-settings-test-fixture'
import { normalizeWorkspaceAttachmentUpdate } from '../../../../../../shared/workspace-attachments'

const mocks = vi.hoisted(() => ({
  assertCapability: vi.fn(),
  callRuntimeRpc: vi.fn(),
  supportsCapability: vi.fn(),
  target: { kind: 'environment', environmentId: 'env-1' } as RuntimeClientTarget
}))

vi.mock('../../../../runtime/runtime-rpc-client', () => ({
  assertRuntimeEnvironmentCapability: mocks.assertCapability,
  callRuntimeRpc: mocks.callRuntimeRpc,
  getActiveRuntimeTarget: () => mocks.target,
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
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

  it.each([
    { linkedPR: 42 },
    { linkedPR: null },
    { linkedGitLabMR: 7 },
    { linkedGitLabMR: null },
    { linkedIssue: 9 },
    { linkedIssue: null }
  ])('does not require a collection capability for scalar writes: %j', async (updates) => {
    mocks.assertCapability.mockRejectedValue(new Error('collection unsupported'))
    await persistWorktreeMeta(createGlobalSettingsFixture(), 'repo::/feature', updates)
    expect(mocks.assertCapability).not.toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      mocks.target,
      'worktree.set',
      { worktree: 'id:repo::/feature', ...updates },
      { timeoutMs: 15_000 }
    )
  })

  it.each([true, false])(
    'keeps review selection exclusive when collection support is %s',
    async (supportsCollections) => {
      mocks.supportsCapability.mockResolvedValue(supportsCollections)
      await persistWorktreeMeta(createGlobalSettingsFixture(), 'repo::/feature', {
        linkedGitLabMR: 7
      })
      const wire = mocks.callRuntimeRpc.mock.lastCall?.[2]
      expect(wire).not.toHaveProperty('linkedItems')
      expect(wire).not.toHaveProperty('linkedItemsBase')
      const saved = supportsCollections
        ? normalizeWorkspaceAttachmentUpdate({ linkedPR: 42 }, wire)
        : { linkedPR: 42, ...wire }
      expect(saved).toMatchObject({ linkedPR: null, linkedGitLabMR: 7 })
      if (supportsCollections) {
        expect(wire).not.toHaveProperty('linkedPR')
        expect(saved.linkedItems).toEqual([
          { provider: 'github', type: 'pr', number: 42 },
          { provider: 'gitlab', type: 'mr', number: 7 }
        ])
      }
      expect(mocks.assertCapability).not.toHaveBeenCalled()
    }
  )

  it('requires host support before sending a positive suppression write', async () => {
    mocks.assertCapability.mockRejectedValue(new Error('update required'))

    await expect(
      persistWorktreeMeta({} as never, 'repo::/feature', { suppressedGitHubPR: 42 })
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
      persistWorktreeMeta(createGlobalSettingsFixture(), 'repo::/feature', { linkedItems: [] })
    ).rejects.toThrow('update required')
    expect(mocks.assertCapability).toHaveBeenCalledWith(
      'env-1',
      WORKTREE_LINKED_ITEMS_RUNTIME_CAPABILITY,
      'Update the remote runtime to change workspace links'
    )
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('sends the complete collection to a capable host', async () => {
    const linkedItems = [
      { provider: 'github', type: 'pr', number: 42 },
      { provider: 'gitlab', type: 'mr', number: 7 }
    ] as const
    await persistWorktreeMeta(createGlobalSettingsFixture(), 'repo::/feature', {
      linkedItems: [...linkedItems]
    })
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      mocks.target,
      'worktree.set',
      { worktree: 'id:repo::/feature', linkedItems },
      { timeoutMs: 15_000 }
    )
  })

  it('sends positive suppression writes to capable hosts', async () => {
    await persistWorktreeMeta({} as never, 'repo::/feature', { suppressedGitHubPR: 42 })

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      mocks.target,
      'worktree.set',
      { worktree: 'id:repo::/feature', suppressedGitHubPR: 42 },
      { timeoutMs: 15_000 }
    )
  })

  it('strips null clears for older hosts while preserving compatible updates', async () => {
    mocks.supportsCapability.mockResolvedValue(false)

    await persistWorktreeMeta({} as never, 'repo::/feature', {
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

  it('keeps null clears for capable hosts', async () => {
    await persistWorktreeMeta({} as never, 'repo::/feature', {
      linkedPR: 42,
      suppressedGitHubPR: null
    })

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      mocks.target,
      'worktree.set',
      { worktree: 'id:repo::/feature', linkedPR: 42, suppressedGitHubPR: null },
      { timeoutMs: 15_000 }
    )
  })

  it('preserves host-owned suppression writes without a paired-runtime capability check', async () => {
    const updateMeta = vi.fn().mockResolvedValue(undefined)
    mocks.target = { kind: 'local' }
    vi.stubGlobal('window', { api: { worktrees: { updateMeta } } })

    await persistWorktreeMeta(
      {} as never,
      'repo::/feature',
      { suppressedGitHubPR: 42 },
      'ssh:build-box'
    )

    expect(updateMeta).toHaveBeenCalledWith({
      worktreeId: 'repo::/feature',
      executionHostId: 'ssh:build-box',
      updates: { suppressedGitHubPR: 42 }
    })
    expect(mocks.assertCapability).not.toHaveBeenCalled()
  })
  it('gates and forwards the atomic collection snapshot', async () => {
    await persistWorktreeMeta(createGlobalSettingsFixture(), 'repo::/feature', {
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
      persistWorktreeMeta(createGlobalSettingsFixture(), 'repo::/feature', {
        linkedItems: [],
        linkedItemsBase: [],
        linkedItemsSelectionChanged: false
      })
    ).rejects.toThrow('atomic support required')
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })
})
