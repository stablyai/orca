import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { FolderWorkspace, ProjectGroup } from '../../../../shared/types'
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
