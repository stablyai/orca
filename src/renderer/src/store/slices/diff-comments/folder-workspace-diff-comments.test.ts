import { selectDiffCommentView, type DiffCommentOwner } from './diff-comment-owner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../../types'
import type { DiffComment } from '../../../../../shared/diff-comment-types'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../../shared/project-group-types'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import { SELF_LOCAL_AUTHORITY } from '../../../../../shared/host-authority'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { clearRuntimeEnvironmentConnectionGenerations as clearRuntimeEnvironmentConnectionGenerationsForTests } from '../runtime-status/runtime-status-connection-generation'

import { createDiffCommentsSlice } from './create-diff-comments-slice'
import { makeProjectGroup } from '@/components/sidebar/workspace-creation/folder/folder-workspace-composer-submit-fixtures'

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
  return store.getState().addDiffComment(capturedOwner(store, workspaceKey), {
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
  clearRuntimeEnvironmentConnectionGenerationsForTests()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
})

describe('folder workspace diff comments', () => {
  it.each([false, true])(
    'keeps inherited same-id writes scoped to their original hosts, reversed=%s',
    async (reverse) => {
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
        executionHostId: undefined
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
        repos: [],
        projectGroups: [
          {
            ...makeProjectGroup(),
            id: 'runtime-group',
            executionHostId: 'runtime:env-owner',
            connectionId: 'box'
          }
        ],
        folderWorkspaces: reverse
          ? [runtimeWorkspace, localWorkspace]
          : [localWorkspace, runtimeWorkspace]
      })

      const localAdd = store.getState().addDiffComment(capturedOwner(store, workspaceKey), {
        worktreeId: workspaceKey,
        filePath: 'LOCAL.md',
        source: 'markdown',
        lineNumber: 1,
        body: 'local note',
        side: 'modified'
      })
      await vi.waitFor(() => expect(folderWorkspacesUpdate).toHaveBeenCalledOnce())

      store.setState({ activeWorkspaceExecutionHostId: 'runtime:env-owner' })
      const runtimeAdd = store.getState().addDiffComment(capturedOwner(store, workspaceKey), {
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
    }
  )
})

describe('folder workspace diff comment rollback convergence', () => {
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errSpy.mockRestore()
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
})

function capturedOwner(store: { getState: () => AppState }, worktreeId: string): DiffCommentOwner {
  return (
    // An unlisted id stands for a copy that is gone, so actions on it are refused.
    selectDiffCommentView(store.getState(), worktreeId, 'selection').owner ?? {
      kind: 'worktree',
      worktreeId,
      authority: SELF_LOCAL_AUTHORITY
    }
  )
}
