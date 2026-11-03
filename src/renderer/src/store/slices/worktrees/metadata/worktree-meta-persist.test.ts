import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY } from '../../../../../../shared/remote-runtime/protocol/worktree-runtime-capabilities'
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

describe('persistWorktreeMeta GitLab link compatibility', () => {
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
    // Why: GitLab slots are gated on the work-item capability; only collection ones must stay unchecked.
    const collectionCapabilities: string[] = [
      WORKTREE_LINKED_ITEMS_RUNTIME_CAPABILITY,
      WORKTREE_LINKED_ITEMS_DELTA_RUNTIME_CAPABILITY
    ]
    mocks.assertCapability.mockImplementation(async (_env: string, capability: string) => {
      if (collectionCapabilities.includes(capability)) {
        throw new Error('collection unsupported')
      }
    })
    await persistWorktreeMeta(mocks.target, 'repo::/feature', updates)
    for (const call of mocks.assertCapability.mock.calls) {
      expect(collectionCapabilities).not.toContain(call[1])
    }
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      mocks.target,
      'worktree.set',
      { worktree: 'id:repo::/feature', ...updates },
      { timeoutMs: 15_000 }
    )
  })

  // Why: worktree.set strips the unknown key and applies linkedIssue: null, so an
  // ungated save would delete the GitHub link and store nothing in its place.
  it('refuses a GitLab issue write against a runtime that predates the field', async () => {
    mocks.assertCapability.mockRejectedValue(new Error('update required'))

    await expect(
      persistWorktreeMeta(mocks.target, 'repo::/feature', {
        linkedGitLabIssue: 43,
        linkedIssue: null
      })
    ).rejects.toThrow('update required')

    expect(mocks.assertCapability).toHaveBeenCalledWith(
      'env-1',
      WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY,
      'Update the remote runtime to link GitLab issues and merge requests'
    )
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('sends a GitLab issue write to a runtime that advertises the work-item capability', async () => {
    await persistWorktreeMeta(mocks.target, 'repo::/feature', {
      linkedGitLabIssue: 43,
      linkedIssue: null
    })

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      mocks.target,
      'worktree.set',
      expect.objectContaining({ linkedGitLabIssue: 43, linkedIssue: null }),
      expect.anything()
    )
  })

  it('refuses a GitLab MR write against a runtime that predates the field', async () => {
    mocks.assertCapability.mockRejectedValue(new Error('update required'))

    await expect(
      persistWorktreeMeta(mocks.target, 'repo::/feature', { linkedGitLabMR: 9 })
    ).rejects.toThrow('update required')

    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('sends a GitLab MR write to a capable runtime', async () => {
    await persistWorktreeMeta(mocks.target, 'repo::/feature', { linkedGitLabMR: 9 })

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      mocks.target,
      'worktree.set',
      expect.objectContaining({ linkedGitLabMR: 9 }),
      expect.anything()
    )
  })

  it('leaves local GitLab writes ungated', async () => {
    const updateMeta = vi.fn().mockResolvedValue(undefined)
    mocks.target = { kind: 'local' }
    vi.stubGlobal('window', { api: { worktrees: { updateMeta } } })

    await persistWorktreeMeta(mocks.target, 'repo::/feature', { linkedGitLabIssue: 43 })

    expect(updateMeta).toHaveBeenCalled()
    expect(mocks.assertCapability).not.toHaveBeenCalled()
  })
})
