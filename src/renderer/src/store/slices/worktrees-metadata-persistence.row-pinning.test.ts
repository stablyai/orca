import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { makeFolderWorkspace, makeWorktree } from './worktrees-slice-test-fixtures'
import { isColorTagPersistencePending } from './worktrees/metadata/worktree-meta-persist'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from './worktrees-slice-test-harness'

// Why mock: failure paths may toast; the assertions here are on store state and on what was written.
vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

beforeEach(resetWorktreeSliceModuleMemory)

describe('runtime-owner-scoped writes for identity-less rows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  // Regression: a detected-only nested-SSH row has no canonical identity; addressed by id and host
  // alone, the optimistic apply hit its sibling from another HUB and persistence could route to the
  // desktop or the wrong HUB.
  it('applies to and persists through the named runtime owner only', async () => {
    const store = createTestStore()
    const shared = makeWorktree({
      id: 'repo1::/srv/nested',
      repoId: 'repo1',
      path: '/srv/nested',
      colorTag: null
    })
    const viaA = { ...shared, runtimeOwnerEnvironmentId: 'env-a' }
    const viaB = { ...shared, runtimeOwnerEnvironmentId: 'env-b' }
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-set',
      ok: true,
      result: { worktree: { ...viaB, colorTag: '#ef4444' } },
      _meta: { runtimeId: 'runtime-b' }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-a' } as never,
      worktreesByRepo: { repo1: [viaA, viaB] }
    } as Partial<AppState>)

    await store
      .getState()
      .updateWorktreeMeta(
        shared.id,
        { colorTag: '#ef4444' },
        { runtimeOwnerEnvironmentId: 'env-b' }
      )

    expect(store.getState().worktreesByRepo.repo1.map((worktree) => worktree.colorTag)).toEqual([
      null,
      '#ef4444'
    ])
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(runtimeEnvironmentCall.mock.calls[0])).toContain('env-b')
  })

  // Regression: the prior color came from an id-and-host lookup that could land on the sibling row
  // or on nothing, so a failed write whose recovery could not run rolled the selected row back to
  // the sibling's color or cleared it outright.
  it("rolls a failed write back to the owner's own prior color", async () => {
    const store = createTestStore()
    const shared = makeWorktree({ id: 'repo1::/srv/nested', repoId: 'repo1', path: '/srv/nested' })
    const viaA = { ...shared, runtimeOwnerEnvironmentId: 'env-a', colorTag: '#ef4444' }
    const viaB = { ...shared, runtimeOwnerEnvironmentId: 'env-b', colorTag: '#3b82f6' }
    runtimeEnvironmentCall.mockRejectedValue(new Error('host away'))
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-a' } as never,
      worktreesByRepo: { repo1: [viaA, viaB] },
      fetchWorktrees: vi.fn().mockResolvedValue(false)
    } as unknown as Partial<AppState>)

    const result = await store
      .getState()
      .updateWorktreeMeta(
        shared.id,
        { colorTag: '#22c55e' },
        { runtimeOwnerEnvironmentId: 'env-b' }
      )

    expect(result.ok).toBe(false)
    expect(store.getState().worktreesByRepo.repo1.map((worktree) => worktree.colorTag)).toEqual([
      '#ef4444',
      '#3b82f6'
    ])
  })

  it('reports not-found rather than touching the sibling when the owner has no such row', async () => {
    const store = createTestStore()
    const viaA = {
      ...makeWorktree({
        id: 'repo1::/srv/nested',
        repoId: 'repo1',
        path: '/srv/nested',
        colorTag: null
      }),
      runtimeOwnerEnvironmentId: 'env-a'
    }
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-a' } as never,
      worktreesByRepo: { repo1: [viaA] }
    } as Partial<AppState>)

    const result = await store
      .getState()
      .updateWorktreeMeta(viaA.id, { colorTag: '#ef4444' }, { runtimeOwnerEnvironmentId: 'env-b' })

    expect(result.ok).toBe(false)
    expect(store.getState().worktreesByRepo.repo1[0]?.colorTag).toBeNull()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })
})

describe('identity-pinned writes across a rename during the preflight yield', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  // Regression: the pinned row was re-resolved after the awaited preflight, but apply, persistence,
  // and rollback kept the id from before the yield; a rename during it left the reducers matching
  // nothing and local IPC holding a retired locator.
  it('applies and persists under the id the row has after the yield', async () => {
    const store = createTestStore()
    const before = makeWorktree({
      id: 'repo1::/path/before',
      repoId: 'repo1',
      path: '/path/before',
      identity: { key: 'k-same' } as never,
      colorTag: null
    })
    const after = { ...before, id: 'repo1::/path/after', path: '/path/after' }
    store.setState({ worktreesByRepo: { repo1: [before] } } as Partial<AppState>)

    const pending = store
      .getState()
      .updateWorktreeMeta(before.id, { colorTag: '#ef4444' }, { identityKey: 'k-same' })
    store.setState({ worktreesByRepo: { repo1: [after] } } as Partial<AppState>)
    const result = await pending

    expect(result.ok).toBe(true)
    expect(store.getState().worktreesByRepo.repo1[0]?.colorTag).toBe('#ef4444')
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledTimes(1)
    expect(mockApi.worktrees.updateMeta.mock.calls[0]?.[0]).toMatchObject({
      worktreeId: 'repo1::/path/after',
      identityKey: 'k-same'
    })
  })
})

describe('identity-pinned writes across a rename while the write is failing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  // Regression: the rollback found the renamed row by identity but addressed the reducers with the
  // id the write started under, so nothing was reverted and the unsaved color stayed on the card.
  it('rolls the renamed row back under its current id when recovery cannot refresh', async () => {
    const store = createTestStore()
    const before = makeWorktree({
      id: 'repo1::/path/failing-before',
      repoId: 'repo1',
      path: '/path/failing-before',
      identity: { key: 'k-fail' } as never,
      colorTag: null
    })
    let rejectWrite: (error: Error) => void = () => undefined
    mockApi.worktrees.updateMeta.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectWrite = reject
        })
    )
    store.setState({
      worktreesByRepo: { repo1: [before] },
      fetchWorktrees: vi.fn().mockResolvedValue(false)
    } as unknown as Partial<AppState>)

    const pending = store
      .getState()
      .updateWorktreeMeta(before.id, { colorTag: '#ef4444' }, { identityKey: 'k-fail' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.getState().worktreesByRepo.repo1[0]?.colorTag).toBe('#ef4444')
    // Reconciliation renames the row, carrying the optimistic color, while the write is failing.
    store.setState({
      worktreesByRepo: {
        repo1: [
          {
            ...before,
            id: 'repo1::/path/failing-after',
            path: '/path/failing-after',
            colorTag: '#ef4444'
          }
        ]
      }
    } as Partial<AppState>)
    rejectWrite(new Error('host away'))
    const result = await pending

    expect(result.ok).toBe(false)
    expect(store.getState().worktreesByRepo.repo1[0]?.id).toBe('repo1::/path/failing-after')
    expect(store.getState().worktreesByRepo.repo1[0]?.colorTag).toBeNull()
  })
})

describe('direct-owner pins for identity-less rows the desktop lists itself', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  // Regression: the desktop listed a checkout directly while a HUB published it as an identity-less
  // sibling with the same id and host; an unpinned write recolored both rows and the id-and-host owner
  // guess persisted the tag through the HUB.
  it('colors only the direct row and persists through the desktop', async () => {
    const store = createTestStore()
    const direct = makeWorktree({
      id: 'repo1::/srv/dual',
      repoId: 'repo1',
      path: '/srv/dual',
      hostId: 'ssh:box' as never,
      colorTag: null
    })
    const viaHub = { ...direct, runtimeOwnerEnvironmentId: 'env-hub' }
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-hub' } as never,
      worktreesByRepo: { repo1: [direct, viaHub] }
    } as Partial<AppState>)

    const result = await store
      .getState()
      .updateWorktreeMeta(
        direct.id,
        { colorTag: '#ef4444' },
        { executionHostId: 'ssh:box' as never, runtimeOwnerEnvironmentId: null }
      )

    expect(result.ok).toBe(true)
    expect(store.getState().worktreesByRepo.repo1.map((worktree) => worktree.colorTag)).toEqual([
      '#ef4444',
      null
    ])
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledTimes(1)
  })

  it('reports not-found when only a HUB still publishes the row', async () => {
    const store = createTestStore()
    const viaHub = {
      ...makeWorktree({
        id: 'repo1::/srv/dual',
        repoId: 'repo1',
        path: '/srv/dual',
        hostId: 'ssh:box' as never,
        colorTag: null
      }),
      runtimeOwnerEnvironmentId: 'env-hub'
    }
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-hub' } as never,
      worktreesByRepo: { repo1: [viaHub] }
    } as Partial<AppState>)

    const result = await store
      .getState()
      .updateWorktreeMeta(
        viaHub.id,
        { colorTag: '#ef4444' },
        { executionHostId: 'ssh:box' as never, runtimeOwnerEnvironmentId: null }
      )

    expect(result.ok).toBe(false)
    expect(store.getState().worktreesByRepo.repo1[0]?.colorTag).toBeNull()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })
})

describe('batch metadata writes carry the same pin as single-row writes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  // Regression: the batch path pinned only the identity, so an identity-less row's fence fell back
  // to id and host and could hold a sibling runtime's refresh, and a held listing was never
  // reconciled because no refetch hook was passed.
  it('fences a batch color write by owner and refetches once a listing is held', async () => {
    const store = createTestStore()
    const row = makeWorktree({
      id: 'repo1::/path/batch',
      repoId: 'repo1',
      path: '/path/batch',
      hostId: 'local' as never,
      colorTag: null
    })
    const fetchWorktrees = vi.fn().mockResolvedValue(true)
    store.setState({
      worktreesByRepo: { repo1: [row] },
      fetchWorktrees
    } as unknown as Partial<AppState>)
    const before = Date.now() - 1

    await store
      .getState()
      .updateWorktreesMeta([
        { worktreeId: row.id, updates: { colorTag: '#ef4444' }, executionHostId: 'local' as never }
      ])

    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledTimes(1)
    expect(isColorTagPersistencePending(row.id, 'local', before, undefined, 'env-other')).toBe(
      false
    )
    expect(isColorTagPersistencePending(row.id, 'local', before, undefined, null)).toBe(true)
    await Promise.resolve()
    expect(fetchWorktrees).toHaveBeenCalledWith('repo1', { executionHostId: 'local' })
  })
})

describe('runtime-owner pins on folder workspaces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  // Regression: the folder projection carries its paired runtime as owner, the color writer
  // forwards it as a pin, and the pinned lookup searched only the git catalogs, so every color
  // write to a runtime-owned folder workspace was rejected as "no longer available".
  it('colors a folder workspace owned by a paired runtime through the folder route', async () => {
    const store = createTestStore()
    const hostId = toRuntimeExecutionHostId('env-b')
    const folder = makeFolderWorkspace({ id: 'folder-b', executionHostId: hostId, colorTag: null })
    const updateFolderWorkspace = vi.fn().mockResolvedValue(true)
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-a' } as never,
      folderWorkspaces: [folder],
      updateFolderWorkspace
    } as unknown as Partial<AppState>)

    const result = await store
      .getState()
      .updateWorktreeMeta(
        folderWorkspaceKey(folder.id),
        { colorTag: '#ef4444' },
        { executionHostId: hostId, runtimeOwnerEnvironmentId: 'env-b' }
      )

    expect(result.ok).toBe(true)
    expect(updateFolderWorkspace).toHaveBeenCalledWith(
      'folder-b',
      { colorTag: '#ef4444' },
      { executionHostId: hostId }
    )
  })

  it('still reports not-found for a folder pinned to an owner it no longer has', async () => {
    const store = createTestStore()
    const folder = makeFolderWorkspace({
      id: 'folder-b',
      executionHostId: toRuntimeExecutionHostId('env-b'),
      colorTag: null
    })
    const updateFolderWorkspace = vi.fn().mockResolvedValue(true)
    store.setState({
      folderWorkspaces: [folder],
      updateFolderWorkspace
    } as unknown as Partial<AppState>)

    const result = await store
      .getState()
      .updateWorktreeMeta(
        folderWorkspaceKey(folder.id),
        { colorTag: '#ef4444' },
        { runtimeOwnerEnvironmentId: 'env-c' }
      )

    expect(result.ok).toBe(false)
    expect(updateFolderWorkspace).not.toHaveBeenCalled()
  })
})

describe('pinned identity over local IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  // Regression: local persistence dropped the pinned identity, so main could not tell that the
  // occupant had changed between the renderer's lookup and the write.
  it('forwards the pinned identity so main can validate the occupant', async () => {
    const store = createTestStore()
    const row = makeWorktree({
      id: 'repo1::/path/pinned',
      repoId: 'repo1',
      path: '/path/pinned',
      identity: { key: 'k-pin' } as never,
      colorTag: null
    })
    store.setState({ worktreesByRepo: { repo1: [row] } } as Partial<AppState>)

    await store
      .getState()
      .updateWorktreeMeta(row.id, { colorTag: '#ef4444' }, { identityKey: 'k-pin' })

    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledTimes(1)
    expect(mockApi.worktrees.updateMeta.mock.calls[0]?.[0]).toMatchObject({
      worktreeId: row.id,
      identityKey: 'k-pin'
    })
  })
})
