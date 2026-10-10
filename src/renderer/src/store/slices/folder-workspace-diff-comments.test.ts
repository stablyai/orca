import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createDiffCommentsSlice } from './diffComments'

const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()
const folderWorkspacesUpdate = vi.fn()

globalThis.window = {
  api: {
    folderWorkspaces: { update: folderWorkspacesUpdate },
    runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
  }
} as never

function createTestStore() {
  return create<AppState>()((...args) => {
    const slice = createDiffCommentsSlice(...args)
    return {
      ...slice,
      settings: null,
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      folderWorkspaces: [],
      projectGroups: [],
      runtimeEnvironments: [],
      restoredRuntimeHostIdByWorkspaceSessionKey: {},
      worktreesByRepo: {}
    } as unknown as AppState
  })
}

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-1',
    projectGroupId: 'group-1',
    folderPath: '/workspace',
    executionHostId: 'local',
    diffComments: [],
    ...overrides
  } as FolderWorkspace
}

function seedLocalFolderWorkspace(store: ReturnType<typeof createTestStore>): FolderWorkspace {
  const folderWorkspace = makeFolderWorkspace()
  const projectGroup = {
    id: folderWorkspace.projectGroupId,
    parentPath: '/workspace',
    executionHostId: 'local'
  } as ProjectGroup
  store.setState({
    activeWorktreeId: folderWorkspaceKey(folderWorkspace.id),
    activeWorkspaceExecutionHostId: 'local',
    projectGroups: [projectGroup],
    folderWorkspaces: [folderWorkspace]
  })
  return folderWorkspace
}

function addNote(
  store: ReturnType<typeof createTestStore>,
  workspaceKey: string,
  body: string,
  lineNumber = 1
): Promise<DiffComment | null> {
  return store.getState().addDiffComment({
    worktreeId: workspaceKey,
    filePath: 'README.md',
    source: 'markdown',
    lineNumber,
    body,
    side: 'modified'
  })
}

function bodies(store: ReturnType<typeof createTestStore>, workspaceKey: string): string[] {
  return store
    .getState()
    .getDiffComments(workspaceKey)
    .map((comment) => comment.body)
}

beforeEach(() => {
  vi.clearAllMocks()
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
})

describe('folder workspace diff comments', () => {
  it('adds and persists a review note', async () => {
    const store = createTestStore()
    const folderWorkspace = seedLocalFolderWorkspace(store)
    folderWorkspacesUpdate.mockImplementation(async ({ updates }) => ({
      ...folderWorkspace,
      ...updates
    }))

    const saved = await store.getState().addDiffComment({
      worktreeId: folderWorkspaceKey(folderWorkspace.id),
      filePath: 'README.md',
      source: 'markdown',
      lineNumber: 1,
      body: 'folder note',
      side: 'modified'
    })

    expect(saved).toEqual(expect.objectContaining({ body: 'folder note' }))
    expect(store.getState().getDiffComments(folderWorkspaceKey(folderWorkspace.id))).toEqual([
      expect.objectContaining({ body: 'folder note' })
    ])
    expect(folderWorkspacesUpdate).toHaveBeenCalledWith({
      folderWorkspaceId: folderWorkspace.id,
      updates: { diffComments: [expect.objectContaining({ body: 'folder note' })] }
    })
  })

  it('preserves a second note while the first write is in flight', async () => {
    const store = createTestStore()
    const folderWorkspace = seedLocalFolderWorkspace(store)
    let releaseFirstWrite: (() => void) | undefined
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    folderWorkspacesUpdate.mockImplementation(async ({ updates }) => {
      if (folderWorkspacesUpdate.mock.calls.length === 1) {
        await firstWrite
      }
      return { ...folderWorkspace, ...updates }
    })

    const addFirst = store.getState().addDiffComment({
      worktreeId: folderWorkspaceKey(folderWorkspace.id),
      filePath: 'README.md',
      source: 'markdown',
      lineNumber: 1,
      body: 'first note',
      side: 'modified'
    })
    await vi.waitFor(() => expect(folderWorkspacesUpdate).toHaveBeenCalledTimes(1))
    const addSecond = store.getState().addDiffComment({
      worktreeId: folderWorkspaceKey(folderWorkspace.id),
      filePath: 'README.md',
      source: 'markdown',
      lineNumber: 2,
      body: 'second note',
      side: 'modified'
    })
    releaseFirstWrite?.()

    await Promise.all([addFirst, addSecond])
    expect(store.getState().getDiffComments(folderWorkspaceKey(folderWorkspace.id))).toEqual([
      expect.objectContaining({ body: 'first note' }),
      expect.objectContaining({ body: 'second note' })
    ])
    expect(folderWorkspacesUpdate).toHaveBeenLastCalledWith({
      folderWorkspaceId: folderWorkspace.id,
      updates: {
        diffComments: [
          expect.objectContaining({ body: 'first note' }),
          expect.objectContaining({ body: 'second note' })
        ]
      }
    })
  })

  it('keeps same-id writes scoped to their original hosts', async () => {
    const store = createTestStore()
    const workspaceId = 'shared-folder-id'
    const workspaceKey = folderWorkspaceKey(workspaceId)
    const localWorkspace = makeFolderWorkspace({
      id: workspaceId,
      projectGroupId: 'local-group',
      folderPath: '/workspace/local'
    })
    const runtimeWorkspace = makeFolderWorkspace({
      id: workspaceId,
      projectGroupId: 'runtime-group',
      folderPath: '/workspace/runtime',
      executionHostId: 'runtime:env-owner'
    })
    let resolveLocal!: () => void
    folderWorkspacesUpdate.mockImplementation(
      ({ updates }) =>
        new Promise<FolderWorkspace>((resolve) => {
          resolveLocal = () => resolve({ ...localWorkspace, ...updates })
        })
    )
    runtimeEnvironmentCall.mockImplementation(async (args: RuntimeEnvironmentCallRequest) => ({
      id: 'rpc-folder-update',
      ok: true,
      result: {
        folderWorkspace: {
          ...runtimeWorkspace,
          ...(
            args as RuntimeEnvironmentCallRequest & {
              params: { updates?: Partial<FolderWorkspace> }
            }
          ).params.updates
        }
      },
      _meta: { runtimeId: 'remote-runtime' }
    }))
    store.setState({
      activeWorktreeId: workspaceKey,
      activeWorkspaceExecutionHostId: 'local',
      folderWorkspaces: [localWorkspace, runtimeWorkspace]
    })

    const localAdd = store.getState().addDiffComment({
      worktreeId: workspaceKey,
      filePath: 'LOCAL.md',
      source: 'markdown',
      lineNumber: 1,
      body: 'local note',
      side: 'modified'
    })
    await vi.waitFor(() => expect(folderWorkspacesUpdate).toHaveBeenCalledOnce())

    store.setState({ activeWorkspaceExecutionHostId: 'runtime:env-owner' })
    const runtimeAdd = store.getState().addDiffComment({
      worktreeId: workspaceKey,
      filePath: 'REMOTE.md',
      source: 'markdown',
      lineNumber: 1,
      body: 'runtime note',
      side: 'modified'
    })
    await vi.waitFor(() =>
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: 'env-owner',
          method: 'folderWorkspace.update',
          params: expect.objectContaining({
            updates: {
              diffComments: [expect.objectContaining({ body: 'runtime note' })]
            }
          })
        })
      )
    )

    store.setState({ activeWorkspaceExecutionHostId: 'local' })
    resolveLocal()
    await expect(Promise.all([localAdd, runtimeAdd])).resolves.toEqual([
      expect.objectContaining({ body: 'local note' }),
      expect.objectContaining({ body: 'runtime note' })
    ])
    expect(store.getState().getDiffComments(workspaceKey)).toEqual([
      expect.objectContaining({ body: 'local note' })
    ])
    store.setState({ activeWorkspaceExecutionHostId: 'runtime:env-owner' })
    expect(store.getState().getDiffComments(workspaceKey)).toEqual([
      expect.objectContaining({ body: 'runtime note' })
    ])
  })
})

describe('folder workspace diff comment rollback convergence', () => {
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errSpy.mockRestore()
  })

  it('converges to disk when two consecutive writes fail', async () => {
    const store = createTestStore()
    const folderWorkspace = seedLocalFolderWorkspace(store)
    const key = folderWorkspaceKey(folderWorkspace.id)
    let rejectFirst!: (err: Error) => void
    folderWorkspacesUpdate.mockImplementation(() => {
      if (folderWorkspacesUpdate.mock.calls.length === 1) {
        return new Promise((_resolve, reject) => {
          rejectFirst = reject
        })
      }
      return Promise.reject(new Error('disk full'))
    })

    const addA = addNote(store, key, 'note A', 1)
    await vi.waitFor(() => expect(folderWorkspacesUpdate).toHaveBeenCalledTimes(1))
    const addB = addNote(store, key, 'note B', 2)
    rejectFirst(new Error('disk full'))

    await expect(Promise.all([addA, addB])).resolves.toEqual([null, null])
    expect(folderWorkspacesUpdate).toHaveBeenCalledTimes(2)
    expect(store.getState().getDiffComments(key)).toEqual([])
  })

  it('converges across three failing writes', async () => {
    const store = createTestStore()
    const folderWorkspace = seedLocalFolderWorkspace(store)
    const key = folderWorkspaceKey(folderWorkspace.id)
    folderWorkspacesUpdate.mockImplementation(() => Promise.reject(new Error('disk full')))

    const adds = [
      addNote(store, key, 'A', 1),
      addNote(store, key, 'B', 2),
      addNote(store, key, 'C', 3)
    ]

    await expect(Promise.all(adds)).resolves.toEqual([null, null, null])
    expect(store.getState().getDiffComments(key)).toEqual([])
  })

  it('keeps a durably saved note when a coalesced write succeeds before a later failure', async () => {
    const store = createTestStore()
    const folderWorkspace = seedLocalFolderWorkspace(store)
    const key = folderWorkspaceKey(folderWorkspace.id)
    folderWorkspacesUpdate.mockImplementation(async ({ updates }) => {
      if (folderWorkspacesUpdate.mock.calls.length > 1) {
        throw new Error('disk full')
      }
      return { ...folderWorkspace, ...updates }
    })

    // Why: both mutations land before the first write dequeues, so write 1 coalesces and persists [A,B].
    const addA = addNote(store, key, 'note A', 1)
    const addB = addNote(store, key, 'note B', 2)

    await Promise.all([addA, addB])
    expect(folderWorkspacesUpdate).toHaveBeenNthCalledWith(1, {
      folderWorkspaceId: folderWorkspace.id,
      updates: {
        diffComments: [
          expect.objectContaining({ body: 'note A' }),
          expect.objectContaining({ body: 'note B' })
        ]
      }
    })
    expect(bodies(store, key)).toEqual(['note A', 'note B'])
  })

  it('converges to the partially-written list when only the first write landed', async () => {
    const store = createTestStore()
    const folderWorkspace = seedLocalFolderWorkspace(store)
    const key = folderWorkspaceKey(folderWorkspace.id)
    let releaseFirst!: () => void
    folderWorkspacesUpdate.mockImplementation(async ({ updates }) => {
      if (folderWorkspacesUpdate.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
        return { ...folderWorkspace, ...updates }
      }
      throw new Error('disk full')
    })

    const addA = addNote(store, key, 'note A', 1)
    await vi.waitFor(() => expect(folderWorkspacesUpdate).toHaveBeenCalledTimes(1))
    const addB = addNote(store, key, 'note B', 2)
    releaseFirst()

    await Promise.all([addA, addB])
    // Why: write 1 persisted only [A], so [A] is the floor B's failure converges to.
    expect(bodies(store, key)).toEqual(['note A'])
  })

  it('seeds a fresh floor for the burst after a failed burst', async () => {
    const store = createTestStore()
    const folderWorkspace = seedLocalFolderWorkspace(store)
    const key = folderWorkspaceKey(folderWorkspace.id)
    folderWorkspacesUpdate.mockImplementation(() => Promise.reject(new Error('disk full')))
    await Promise.all([addNote(store, key, 'A', 1), addNote(store, key, 'B', 2)])
    expect(store.getState().getDiffComments(key)).toEqual([])

    folderWorkspacesUpdate.mockImplementation(async ({ updates }) => ({
      ...folderWorkspace,
      ...updates
    }))
    await addNote(store, key, 'C', 3)

    expect(bodies(store, key)).toEqual(['C'])
    expect(folderWorkspacesUpdate).toHaveBeenLastCalledWith({
      folderWorkspaceId: folderWorkspace.id,
      updates: { diffComments: [expect.objectContaining({ body: 'C' })] }
    })
  })

  it('rolls back to the list the queue drained on, not a stale burst floor', async () => {
    const store = createTestStore()
    const folderWorkspace = seedLocalFolderWorkspace(store)
    const key = folderWorkspaceKey(folderWorkspace.id)
    folderWorkspacesUpdate.mockImplementation(() => Promise.reject(new Error('disk full')))
    await Promise.all([addNote(store, key, 'A', 1), addNote(store, key, 'B', 2)])

    // Why: the drained queue must not carry its floor into the next burst.
    const hydrated = [
      {
        id: 'h1',
        worktreeId: key,
        filePath: 'README.md',
        lineNumber: 9,
        body: 'hydrated',
        createdAt: 1,
        side: 'modified'
      } as DiffComment
    ]
    store.setState({ folderWorkspaces: [{ ...folderWorkspace, diffComments: hydrated }] })

    await addNote(store, key, 'D', 4)

    expect(store.getState().getDiffComments(key)).toBe(hydrated)
  })

  it('keeps an out-of-band replacement when a later mutation in the same burst fails', async () => {
    const store = createTestStore()
    const folderWorkspace = seedLocalFolderWorkspace(store)
    const key = folderWorkspaceKey(folderWorkspace.id)
    let rejectFirst!: (err: Error) => void
    folderWorkspacesUpdate.mockImplementation(() => {
      if (folderWorkspacesUpdate.mock.calls.length === 1) {
        return new Promise((_resolve, reject) => {
          rejectFirst = reject
        })
      }
      return Promise.reject(new Error('disk full'))
    })

    const addA = addNote(store, key, 'note A', 1)
    await vi.waitFor(() => expect(folderWorkspacesUpdate).toHaveBeenCalledTimes(1))
    const hydrated = [
      {
        id: 'h1',
        worktreeId: key,
        filePath: 'README.md',
        lineNumber: 9,
        body: 'hydrated',
        createdAt: 1,
        side: 'modified'
      } as DiffComment
    ]
    store.setState({ folderWorkspaces: [{ ...folderWorkspace, diffComments: hydrated }] })
    const addE = addNote(store, key, 'note E', 2)
    rejectFirst(new Error('disk full'))

    await Promise.all([addA, addE])
    expect(bodies(store, key)).toEqual(['hydrated'])
  })

  it('keeps an out-of-band replacement when the in-flight write succeeds', async () => {
    const store = createTestStore()
    const folderWorkspace = seedLocalFolderWorkspace(store)
    const key = folderWorkspaceKey(folderWorkspace.id)
    let releaseFirst!: () => void
    folderWorkspacesUpdate.mockImplementation(async ({ updates }) => {
      if (folderWorkspacesUpdate.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
        return { ...folderWorkspace, ...updates }
      }
      throw new Error('disk full')
    })

    const addA = addNote(store, key, 'note A', 1)
    await vi.waitFor(() => expect(folderWorkspacesUpdate).toHaveBeenCalledTimes(1))
    const hydrated = [
      {
        id: 'h1',
        worktreeId: key,
        filePath: 'README.md',
        lineNumber: 9,
        body: 'hydrated',
        createdAt: 1,
        side: 'modified'
      } as DiffComment
    ]
    store.setState({ folderWorkspaces: [{ ...folderWorkspace, diffComments: hydrated }] })
    // Why: the chain break re-seeds the floor to `hydrated`; A's success must not restore its pre-replacement capture.
    const addE = addNote(store, key, 'note E', 2)
    releaseFirst()

    await Promise.all([addA, addE])
    expect(bodies(store, key)).toEqual(['hydrated'])
  })

  it('keeps a successful write that straddles a chain break as the floor', async () => {
    const store = createTestStore()
    const folderWorkspace = seedLocalFolderWorkspace(store)
    const key = folderWorkspaceKey(folderWorkspace.id)
    folderWorkspacesUpdate.mockImplementation(async ({ updates }) => {
      if (folderWorkspacesUpdate.mock.calls.length > 1) {
        throw new Error('disk full')
      }
      return { ...folderWorkspace, ...updates }
    })

    // Why: no await, so the replacement + E land before A dequeues — A's payload already carries `hydrated`.
    const addA = addNote(store, key, 'note A', 1)
    const hydrated = [
      {
        id: 'h1',
        worktreeId: key,
        filePath: 'README.md',
        lineNumber: 9,
        body: 'hydrated',
        createdAt: 1,
        side: 'modified'
      } as DiffComment
    ]
    store.setState({ folderWorkspaces: [{ ...folderWorkspace, diffComments: hydrated }] })
    const addE = addNote(store, key, 'note E', 2)

    await Promise.all([addA, addE])
    // Why: write #1 put ['hydrated', 'note E'] on disk, so E's failure must not roll back past it.
    expect(bodies(store, key)).toEqual(['hydrated', 'note E'])
    expect(folderWorkspacesUpdate.mock.calls[0][0].updates.diffComments).toEqual([
      expect.objectContaining({ body: 'hydrated' }),
      expect.objectContaining({ body: 'note E' })
    ])
  })

  it('rolls back when the write throws before reaching persist', async () => {
    const store = createTestStore()
    const folderWorkspace = seedLocalFolderWorkspace(store)
    const key = folderWorkspaceKey(folderWorkspace.id)
    // Why: a malformed entry makes normalizeDiffComment throw inside run, before persist is ever called.
    const malformed = [null as unknown as DiffComment]
    store.setState({ folderWorkspaces: [{ ...folderWorkspace, diffComments: malformed }] })
    folderWorkspacesUpdate.mockImplementation(async ({ updates }) => ({
      ...folderWorkspace,
      ...updates
    }))

    await expect(addNote(store, key, 'note A', 1)).resolves.toBeNull()
    expect(store.getState().getDiffComments(key)).toBe(malformed)
    expect(folderWorkspacesUpdate).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalled()
  })

  it('reports success when recordFeatureInteraction throws after a successful write', async () => {
    const store = createTestStore()
    const folderWorkspace = seedLocalFolderWorkspace(store)
    const key = folderWorkspaceKey(folderWorkspace.id)
    folderWorkspacesUpdate.mockImplementation(async ({ updates }) => ({
      ...folderWorkspace,
      ...updates
    }))
    store.setState({
      recordFeatureInteraction: () => {
        throw new Error('telemetry down')
      }
    } as never)

    await expect(addNote(store, key, 'note A', 1)).resolves.toEqual(
      expect.objectContaining({ body: 'note A' })
    )
    expect(bodies(store, key)).toEqual(['note A'])
  })

  it('converges to the floor when persist rejects after the host may have written', async () => {
    const store = createTestStore()
    const folderWorkspace = seedLocalFolderWorkspace(store)
    const key = folderWorkspaceKey(folderWorkspace.id)
    // Why: pins today's contract for the missing-diffComments throw; STA-4062 owns read-back.
    folderWorkspacesUpdate.mockImplementation(async () => ({}))

    await expect(addNote(store, key, 'note A', 1)).resolves.toBeNull()
    expect(store.getState().getDiffComments(key)).toEqual([])
  })

  it('converges on the runtime branch when two consecutive writes fail', async () => {
    const store = createTestStore()
    const runtimeWorkspace = makeFolderWorkspace({ executionHostId: 'runtime:env-owner' })
    const key = folderWorkspaceKey(runtimeWorkspace.id)
    store.setState({
      activeWorktreeId: key,
      activeWorkspaceExecutionHostId: 'runtime:env-owner',
      folderWorkspaces: [runtimeWorkspace]
    })
    runtimeEnvironmentCall.mockRejectedValue(new Error('runtime unreachable'))

    await expect(
      Promise.all([addNote(store, key, 'A', 1), addNote(store, key, 'B', 2)])
    ).resolves.toEqual([null, null])
    expect(store.getState().getDiffComments(key)).toEqual([])
    expect(folderWorkspacesUpdate).not.toHaveBeenCalled()
  })

  it('keeps a failing burst scoped to its own execution host', async () => {
    const store = createTestStore()
    const workspaceId = 'shared-folder-id'
    const key = folderWorkspaceKey(workspaceId)
    const localWorkspace = makeFolderWorkspace({ id: workspaceId, projectGroupId: 'local-group' })
    const runtimeWorkspace = makeFolderWorkspace({
      id: workspaceId,
      projectGroupId: 'runtime-group',
      executionHostId: 'runtime:env-owner'
    })
    store.setState({
      activeWorktreeId: key,
      activeWorkspaceExecutionHostId: 'runtime:env-owner',
      folderWorkspaces: [localWorkspace, runtimeWorkspace]
    })
    runtimeEnvironmentCall.mockImplementation(async (args: RuntimeEnvironmentCallRequest) => ({
      id: 'rpc-folder-update',
      ok: true,
      result: {
        folderWorkspace: {
          ...runtimeWorkspace,
          ...(
            args as RuntimeEnvironmentCallRequest & {
              params: { updates?: Partial<FolderWorkspace> }
            }
          ).params.updates
        }
      },
      _meta: { runtimeId: 'remote-runtime' }
    }))
    folderWorkspacesUpdate.mockImplementation(() => Promise.reject(new Error('disk full')))

    await addNote(store, key, 'runtime note', 1)
    store.setState({ activeWorkspaceExecutionHostId: 'local' })
    await Promise.all([addNote(store, key, 'local A', 2), addNote(store, key, 'local B', 3)])

    expect(store.getState().getDiffComments(key)).toEqual([])
    store.setState({ activeWorkspaceExecutionHostId: 'runtime:env-owner' })
    expect(bodies(store, key)).toEqual(['runtime note'])
  })
})
