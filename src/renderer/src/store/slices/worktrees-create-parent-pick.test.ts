import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { Worktree } from '../../../../shared/worktree/types'
import { toast } from 'sonner'
import type { RuntimeEnvironmentCallRequest } from '../../runtime/runtime-compatibility-test-fixture'
import { worktreeWorkspaceKey, folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { makeLineage, makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from './worktrees-slice-test-harness'

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
  requestWorktreeBaseFallbackNotice: vi.fn()
}))

beforeEach(resetWorktreeSliceModuleMemory)

describe('createWorktree composer parent pick', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  function createParentPickStore(parent?: Worktree) {
    const store = createTestStore()
    store.setState({ worktreesByRepo: { repo1: parent ? [parent] : [] } } as Partial<AppState>)
    return store
  }

  function createWithParentPick(
    store: ReturnType<typeof createTestStore>,
    parentWorktreeId: string
  ) {
    const createWorktree = store.getState().createWorktree
    const args: Parameters<typeof createWorktree> = ['repo1', 'feature', 'origin/main']
    args[25] = { parentWorktreeId }
    return createWorktree(...args)
  }

  it('nests the new workspace under the picked parent worktree', async () => {
    const parent = makeWorktree({
      id: 'repo1::/path/parent',
      repoId: 'repo1',
      path: '/path/parent',
      instanceId: 'parent-instance'
    })
    const store = createParentPickStore(parent)
    store.setState({ activeWorkspaceKey: folderWorkspaceKey('folder-1') } as Partial<AppState>)
    mockApi.worktrees.create.mockResolvedValue({
      worktree: makeWorktree({ id: 'repo1::/path/child', repoId: 'repo1', path: '/path/child' })
    })

    await createWithParentPick(store, parent.id)

    expect(mockApi.worktrees.create).toHaveBeenCalledWith(
      expect.objectContaining({ parentWorkspace: worktreeWorkspaceKey(parent.id) })
    )
  })

  it('drops a stale parent pick and falls back to the active folder workspace', async () => {
    const store = createParentPickStore()
    store.setState({ activeWorkspaceKey: folderWorkspaceKey('folder-1') } as Partial<AppState>)
    mockApi.worktrees.create.mockResolvedValue({
      worktree: makeWorktree({ id: 'repo1::/path/child', repoId: 'repo1', path: '/path/child' })
    })

    await createWithParentPick(store, 'repo1::/path/removed')

    expect(mockApi.worktrees.create).toHaveBeenCalledWith(
      expect.objectContaining({ parentWorkspace: folderWorkspaceKey('folder-1') })
    )
  })

  it('warns when an archived parent pick is dropped before create', async () => {
    const parent = makeWorktree({
      id: 'repo1::/path/parent',
      repoId: 'repo1',
      path: '/path/parent',
      displayName: 'parent-wt',
      isArchived: true
    })
    const store = createParentPickStore(parent)
    mockApi.worktrees.create.mockResolvedValue({
      worktree: makeWorktree({ id: 'repo1::/path/child', repoId: 'repo1', path: '/path/child' })
    })

    await createWithParentPick(store, parent.id)

    expect(toast.warning).toHaveBeenCalledWith(
      'Created without nesting under "parent-wt"',
      expect.objectContaining({ description: expect.any(String) })
    )
  })

  it('warns when the backend rejects an accepted parent pick', async () => {
    const parent = makeWorktree({
      id: 'repo1::/path/parent',
      repoId: 'repo1',
      path: '/path/parent',
      displayName: 'parent-wt',
      instanceId: 'parent-instance'
    })
    const store = createParentPickStore(parent)
    mockApi.worktrees.create.mockResolvedValue({
      worktree: makeWorktree({ id: 'repo1::/path/child', repoId: 'repo1', path: '/path/child' }),
      lineage: null
    })

    await createWithParentPick(store, parent.id)

    expect(toast.warning).toHaveBeenCalledWith(
      'Created without nesting under "parent-wt"',
      expect.objectContaining({ description: expect.any(String) })
    )
  })

  it('keeps an accepted parent pick quiet and seeds its lineage', async () => {
    const parent = makeWorktree({
      id: 'repo1::/path/parent',
      repoId: 'repo1',
      path: '/path/parent',
      instanceId: 'parent-instance'
    })
    const created = makeWorktree({
      id: 'repo1::/path/child',
      repoId: 'repo1',
      path: '/path/child',
      instanceId: 'child-instance'
    })
    const lineage = makeLineage({
      worktreeId: created.id,
      worktreeInstanceId: 'child-instance',
      parentWorktreeId: parent.id,
      parentWorktreeInstanceId: 'parent-instance'
    })
    const store = createParentPickStore(parent)
    mockApi.worktrees.create.mockResolvedValue({ worktree: created, lineage })

    await createWithParentPick(store, parent.id)

    expect(toast.warning).not.toHaveBeenCalled()
    expect(store.getState().worktreeLineageById[created.id]).toEqual(lineage)
  })

  // Why: paired web clients route window.api.worktrees.create to their host, which still rejects.
  it('retries without the parent when the create API reports the parent is gone', async () => {
    const parent = makeWorktree({
      id: 'repo1::/path/parent',
      repoId: 'repo1',
      path: '/path/parent',
      displayName: 'parent-wt',
      instanceId: 'parent-instance'
    })
    const store = createParentPickStore(parent)
    mockApi.worktrees.create
      .mockRejectedValueOnce(
        Object.assign(new Error('Parent selector was not found.'), {
          code: 'LINEAGE_PARENT_NOT_FOUND'
        })
      )
      .mockResolvedValue({
        worktree: makeWorktree({ id: 'repo1::/path/child', repoId: 'repo1', path: '/path/child' })
      })

    await createWithParentPick(store, parent.id)

    expect(mockApi.worktrees.create).toHaveBeenCalledTimes(2)
    expect(mockApi.worktrees.create.mock.calls[1][0]).not.toHaveProperty('parentWorkspace')
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })

  it('warns once when a dropped pick is followed by branch-conflict retries', async () => {
    const store = createParentPickStore()
    const created = makeWorktree({
      id: 'repo1::/path/child',
      repoId: 'repo1',
      path: '/path/child'
    })
    mockApi.worktrees.create
      .mockRejectedValueOnce(new Error('Branch "feature" already exists locally.'))
      .mockResolvedValue({ worktree: created })

    await createWithParentPick(store, 'repo1::/path/removed')

    expect(mockApi.worktrees.create).toHaveBeenCalledTimes(2)
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })
})

describe('createWorktree parent pick on a remote runtime', () => {
  const REMOTE_REPO = 'repo-remote'
  const PARENT_ID = `${REMOTE_REPO}::/remote/parent`

  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  function createRemoteStore() {
    const store = createTestStore()
    store.setState({
      repos: [
        {
          id: REMOTE_REPO,
          path: '/home/dev/repo',
          displayName: 'repo',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: 'runtime:env-1'
        }
      ],
      worktreesByRepo: {
        [REMOTE_REPO]: [
          makeWorktree({
            id: PARENT_ID,
            repoId: REMOTE_REPO,
            path: '/remote/parent',
            displayName: 'parent-wt',
            instanceId: 'parent-instance'
          })
        ]
      }
    } as Partial<AppState>)
    return store
  }

  function createOnRemote(store: ReturnType<typeof createTestStore>) {
    const createWorktree = store.getState().createWorktree
    const args: Parameters<typeof createWorktree> = [REMOTE_REPO, 'feature', 'origin/main']
    args[25] = { parentWorktreeId: PARENT_ID }
    return createWorktree(...args)
  }

  function createCalls() {
    return runtimeEnvironmentCall.mock.calls
      .map(([request]: [RuntimeEnvironmentCallRequest]) => request)
      .filter((request) => request.method === 'worktree.create')
  }

  function mockRuntimeCreate(firstCreate: (id: string) => unknown) {
    let createCount = 0
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) => {
      if (method !== 'worktree.create') {
        return Promise.resolve({ id: method, ok: true, result: null })
      }
      createCount += 1
      return createCount === 1
        ? Promise.resolve(firstCreate('rpc-create'))
        : Promise.resolve({
            id: 'rpc-create',
            ok: true,
            result: {
              worktree: makeWorktree({
                id: `${REMOTE_REPO}::/remote/child`,
                repoId: REMOTE_REPO,
                path: '/remote/child'
              })
            }
          })
    })
  }

  it('marks an app-selected parent as manual so the host does not record a CLI flag', async () => {
    mockRuntimeCreate((id) => ({
      id,
      ok: true,
      result: {
        worktree: makeWorktree({
          id: `${REMOTE_REPO}::/remote/child`,
          repoId: REMOTE_REPO,
          path: '/remote/child'
        }),
        lineage: makeLineage({
          worktreeId: `${REMOTE_REPO}::/remote/child`,
          parentWorktreeId: PARENT_ID
        })
      }
    }))

    await createOnRemote(createRemoteStore())

    expect(createCalls()[0]?.params).toMatchObject({
      parentWorkspace: worktreeWorkspaceKey(PARENT_ID),
      parentWorkspaceOrigin: 'manual'
    })
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('retries without the parent and warns when the host no longer has it', async () => {
    mockRuntimeCreate((id) => ({
      id,
      ok: false,
      error: { code: 'LINEAGE_PARENT_NOT_FOUND', message: 'Parent selector was not found.' }
    }))

    await createOnRemote(createRemoteStore())

    const calls = createCalls()
    expect(calls).toHaveLength(2)
    expect(calls[1]?.params).not.toHaveProperty('parentWorkspace')
    expect(toast.warning).toHaveBeenCalledWith(
      'Created without nesting under "parent-wt"',
      expect.objectContaining({ description: expect.any(String) })
    )
  })

  it('retries when a transport re-wraps the parent-missing code into a plain error', async () => {
    let createCount = 0
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) => {
      if (method !== 'worktree.create') {
        return Promise.resolve({ id: method, ok: true, result: null })
      }
      createCount += 1
      // Why: the relay envelope re-throws as a plain Error, so only the trailing code survives.
      return createCount === 1
        ? Promise.reject(new Error('Error invoking remote method: LINEAGE_PARENT_NOT_FOUND'))
        : Promise.resolve({
            id: 'rpc-create',
            ok: true,
            result: {
              worktree: makeWorktree({
                id: `${REMOTE_REPO}::/remote/child`,
                repoId: REMOTE_REPO,
                path: '/remote/child'
              })
            }
          })
    })

    await createOnRemote(createRemoteStore())

    expect(createCalls()).toHaveLength(2)
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })

  // Why: the folder parent comes from the active scope, not a pick, so nothing else would surface it.
  it('warns when the retry drops an active folder-workspace parent', async () => {
    const store = createRemoteStore()
    store.setState({
      activeWorkspaceKey: folderWorkspaceKey('folder-1'),
      folderWorkspaces: [{ id: 'folder-1', name: 'Design docs' }]
    } as unknown as Partial<AppState>)
    mockRuntimeCreate((id) => ({
      id,
      ok: false,
      error: { code: 'LINEAGE_PARENT_NOT_FOUND', message: 'Parent selector was not found.' }
    }))
    const createWorktree = store.getState().createWorktree

    await createWorktree(REMOTE_REPO, 'feature', 'origin/main')

    const calls = createCalls()
    expect(calls).toHaveLength(2)
    expect(calls[0]?.params).toMatchObject({ parentWorkspace: folderWorkspaceKey('folder-1') })
    expect(calls[1]?.params).not.toHaveProperty('parentWorkspace')
    expect(toast.warning).toHaveBeenCalledWith(
      'Created without nesting under "Design docs"',
      expect.objectContaining({ description: expect.any(String) })
    )
  })

  it('never double-creates when the host fails for an unrelated reason', async () => {
    mockRuntimeCreate((id) => ({
      id,
      ok: false,
      error: { code: 'internal_error', message: 'disk on fire' }
    }))

    await expect(createOnRemote(createRemoteStore())).rejects.toThrow('disk on fire')

    expect(createCalls()).toHaveLength(1)
    expect(toast.warning).not.toHaveBeenCalled()
  })
})
