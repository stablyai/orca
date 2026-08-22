import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

const folderWorkspacesGetPathStatus = vi.fn()
const runtimeEnvironmentCall = vi.fn()

function projectGroup(executionHostId: 'local' | 'runtime:env-1'): ProjectGroup {
  return {
    id: 'same-group',
    name: 'Same group',
    parentPath: executionHostId === 'local' ? '/local/group' : '/runtime/group',
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    executionHostId
  }
}

function folderWorkspace(executionHostId: 'local' | 'runtime:env-1'): FolderWorkspace {
  return {
    id: 'same-folder',
    projectGroupId: 'same-group',
    name: 'Same folder',
    folderPath: executionHostId === 'local' ? '/local/folder' : '/runtime/folder',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1,
    executionHostId
  }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  folderWorkspacesGetPathStatus.mockReset()
  folderWorkspacesGetPathStatus.mockResolvedValue({ path: '/local/folder', exists: true })
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentCall.mockResolvedValue({
    id: 'rpc-runtime-folder-status',
    ok: true,
    result: { status: { path: '/runtime/folder', exists: true } },
    _meta: { runtimeId: 'runtime-remote' }
  })
  vi.stubGlobal('window', {
    api: {
      folderWorkspaces: { getPathStatus: folderWorkspacesGetPathStatus },
      runtimeEnvironments: {
        call: (args: RuntimeEnvironmentCallRequest) =>
          createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
      }
    }
  })
})

describe('folder path status host identity', () => {
  it('keeps same-id local and runtime snapshots separate', async () => {
    const request = { scope: 'folder-workspace' as const, folderWorkspaceId: 'same-folder' }
    const store = createTestStore()
    store.setState({
      projectGroups: [projectGroup('local'), projectGroup('runtime:env-1')],
      folderWorkspaces: [folderWorkspace('local'), folderWorkspace('runtime:env-1')]
    })

    await store
      .getState()
      .fetchFolderWorkspacePathStatus(request, { force: true, runtimeEnvironmentId: null })
    await store
      .getState()
      .fetchFolderWorkspacePathStatus(request, { force: true, runtimeEnvironmentId: 'env-1' })

    expect(
      store.getState().getFreshFolderWorkspacePathStatus(request, { runtimeEnvironmentId: null })
    ).toEqual({ path: '/local/folder', exists: true })
    expect(
      store.getState().getFreshFolderWorkspacePathStatus(request, { runtimeEnvironmentId: 'env-1' })
    ).toEqual({ path: '/runtime/folder', exists: true })
  })
})
