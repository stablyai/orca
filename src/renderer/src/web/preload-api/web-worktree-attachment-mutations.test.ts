import { WORKTREE_CROSS_MACHINE_LINEAGE_CAPABILITY } from '../../../../shared/worktree-runtime-capabilities'
import { makeLineage } from '../../store/slices/worktrees-slice-test-fixtures'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WORKTREE_LINKED_ITEMS_DELTA_RUNTIME_CAPABILITY,
  WORKTREE_LINKED_ITEMS_RUNTIME_CAPABILITY
} from '../../../../shared/workspace-attachment-capabilities'
import { createWorktreesApi } from './web-worktrees-api'

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  call: vi.fn(),
  plainCall: vi.fn(),
  invalidate: vi.fn(),
  assertEnvironment: vi.fn()
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./web-runtime-calls', () => ({
  getRemoteRuntimeStatus: mocks.status,
  callRuntimeResultWithOwner: mocks.call,
  callRuntimeResult: mocks.plainCall,
  withRuntimeWorktreeOwner: (row: unknown) => row
}))
vi.mock('./web-runtime-session', () => ({
  invalidateRuntimeWorktreeCaches: mocks.invalidate,
  requireActiveEnvironment: () => ({ id: 'env' }),
  assertActiveEnvironment: mocks.assertEnvironment
}))
vi.mock('./web-runtime-worktree-catalog', () => ({ callRuntimeDetectedWorktrees: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.call.mockResolvedValue({ result: { worktree: { id: 'wt' } }, hostId: 'runtime:env' })
})

describe('paired web attachment mutation compatibility', () => {
  it.each([{ linkedPR: null }, { linkedIssue: 9 }, { linkedIssue: null }])(
    'forwards legacy scalar writes without a collection capability: %j',
    async (updates) => {
      mocks.status.mockResolvedValue({ capabilities: [] })
      await createWorktreesApi().updateMeta({ worktreeId: 'wt', updates })
      expect(mocks.status).not.toHaveBeenCalled()
      expect(mocks.call).toHaveBeenCalledWith('worktree.set', { worktree: 'id:wt', ...updates })
    }
  )
  it.each([true, false])(
    'shapes positive review selection for collection support %s',
    async (supported) => {
      mocks.status.mockResolvedValue({
        capabilities: supported ? [WORKTREE_LINKED_ITEMS_RUNTIME_CAPABILITY] : []
      })
      await createWorktreesApi().updateMeta({ worktreeId: 'wt', updates: { linkedGitLabMR: 7 } })
      expect(mocks.call).toHaveBeenCalledWith('worktree.set', {
        worktree: 'id:wt',
        linkedGitLabMR: 7,
        ...(supported
          ? {}
          : {
              linkedPR: null,
              linkedBitbucketPR: null,
              linkedAzureDevOpsPR: null,
              linkedGiteaPR: null
            })
      })
      expect(mocks.assertEnvironment).toHaveBeenCalledWith('env')
    }
  )
  it('does not send a scalar selection to a different host after capability discovery', async () => {
    mocks.status.mockResolvedValue({ capabilities: [] })
    mocks.assertEnvironment.mockImplementationOnce(() => {
      throw new Error('host changed')
    })
    await expect(
      createWorktreesApi().updateMeta({ worktreeId: 'wt', updates: { linkedPR: 42 } })
    ).rejects.toThrow('host changed')
    expect(mocks.call).not.toHaveBeenCalled()
  })
  it('refuses an atomic update when the paired host only supports collection replacement', async () => {
    mocks.status.mockResolvedValue({ capabilities: [WORKTREE_LINKED_ITEMS_RUNTIME_CAPABILITY] })
    const updates = { linkedItems: [], linkedItemsBase: [] }
    await expect(createWorktreesApi().updateMeta({ worktreeId: 'wt', updates })).rejects.toThrow(
      'Update the remote runtime'
    )
    expect(mocks.call).not.toHaveBeenCalled()
  })
  it('forwards the snapshot to a capable paired host', async () => {
    mocks.status.mockResolvedValue({
      capabilities: [
        WORKTREE_LINKED_ITEMS_RUNTIME_CAPABILITY,
        WORKTREE_LINKED_ITEMS_DELTA_RUNTIME_CAPABILITY
      ]
    })
    const updates = { linkedItems: [], linkedItemsBase: [], linkedItemsSelectionChanged: false }
    await createWorktreesApi().updateMeta({ worktreeId: 'wt', updates })
    expect(mocks.assertEnvironment).toHaveBeenCalledWith('env')
    expect(mocks.call).toHaveBeenCalledWith('worktree.set', { worktree: 'id:wt', ...updates })
  })
  it('gates creation and forwards its collection', async () => {
    const args = { repoId: 'repo', name: 'Work', baseBranch: 'main', linkedItems: [] }
    mocks.status.mockResolvedValue({ capabilities: [] })
    await expect(createWorktreesApi().create(args)).rejects.toThrow('Update the remote runtime')
    expect(mocks.call).not.toHaveBeenCalled()
    mocks.status.mockResolvedValue({ capabilities: [WORKTREE_LINKED_ITEMS_RUNTIME_CAPABILITY] })
    await createWorktreesApi().create(args)
    expect(mocks.call).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({ linkedItems: [] })
    )
    vi.clearAllMocks()
    const api = createWorktreesApi()
    const parentWorktreeRef = { worktreeId: 'parent', instanceId: 'chosen-B', external: true }
    mocks.status.mockResolvedValue({ capabilities: [] })
    await expect(api.create({ repoId: 'repo', name: 'Child', parentWorktreeRef })).rejects.toThrow(
      'Update Orca'
    )
    await expect(api.updateLineage({ worktreeId: 'child', parentWorktreeRef })).rejects.toThrow(
      'Update Orca'
    )
    expect(mocks.call).not.toHaveBeenCalled()
    expect(mocks.plainCall).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
    mocks.plainCall.mockResolvedValue({ worktree: { savedLineage: null, lineage: makeLineage() } })
    expect(await api.updateLineage({ worktreeId: 'child', noParent: true })).toBeNull()
    expect(mocks.plainCall).toHaveBeenLastCalledWith('worktree.set', {
      worktree: 'id:child',
      parentWorktree: undefined,
      parentWorktreeRef: undefined,
      noParent: true
    })
    mocks.status.mockResolvedValue({ capabilities: [WORKTREE_CROSS_MACHINE_LINEAGE_CAPABILITY] })
    await api.create({
      repoId: 'repo',
      name: 'Child',
      parentWorkspace: 'worktree:parent',
      parentWorktreeRef
    })
    expect(mocks.call).toHaveBeenLastCalledWith(
      'worktree.create',
      expect.objectContaining({
        parentWorktreeRef,
        parentWorkspace: 'worktree:parent',
        parentWorkspaceOrigin: 'manual'
      })
    )
    expect(await api.updateLineage({ worktreeId: 'child', parentWorktreeRef })).toBeNull()
    expect(mocks.plainCall).toHaveBeenLastCalledWith('worktree.set', {
      worktree: 'id:child',
      parentWorktree: undefined,
      parentWorktreeRef,
      noParent: undefined
    })
  })
})
