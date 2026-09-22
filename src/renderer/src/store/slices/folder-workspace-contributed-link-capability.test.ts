import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import {
  createCompatibleRuntimeStatusResponse,
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

const projectGroup: ProjectGroup = {
  id: 'group-1',
  name: 'Platform',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const CONTRIBUTED_LINKED_TASK: FolderWorkspace['linkedTask'] = {
  provider: 'plugin',
  type: 'issue',
  number: 0,
  title: 'AB-41 Contributed item',
  url: 'https://boards.example.com/AB-41',
  pluginKey: 'azure-boards',
  sourceId: 'board-1'
}

function makeFolderWorkspace(linkedTask: FolderWorkspace['linkedTask']): FolderWorkspace {
  return {
    id: 'folder-workspace-plugin',
    projectGroupId: projectGroup.id,
    name: 'Contributed folder',
    folderPath: '/workspace/platform',
    linkedTask,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

const folderWorkspacesCreate = vi.fn()
const folderWorkspacesGetPathStatus = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

/** Replies to `status.get` with a host that advertises everything but this capability. */
function serveHostWithoutPluginProviderCapability(): void {
  const oldRuntimeStatus = createCompatibleRuntimeStatusResponse('runtime-old')
  if (oldRuntimeStatus.ok) {
    oldRuntimeStatus.result.capabilities = oldRuntimeStatus.result.capabilities?.filter(
      (capability) => capability !== 'worktree.linked-work-item-plugin-provider.v1'
    )
  }
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
    args.method === 'status.get' ? oldRuntimeStatus : runtimeEnvironmentCall(args)
  )
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.mocked(toast.warning).mockClear()
  folderWorkspacesCreate.mockReset()
  folderWorkspacesGetPathStatus.mockReset()
  folderWorkspacesGetPathStatus.mockResolvedValue({ path: '/workspace/platform', exists: true })
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      folderWorkspaces: {
        create: folderWorkspacesCreate,
        getPathStatus: folderWorkspacesGetPathStatus
      },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('folder workspace creation from a contributed task item', () => {
  it('sends the contributed linked task to a host advertising the plugin provider capability', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-create-folder',
      ok: true,
      result: { folderWorkspace: makeFolderWorkspace(CONTRIBUTED_LINKED_TASK) },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()

    await store.getState().createFolderWorkspace(
      {
        projectGroupId: projectGroup.id,
        name: 'Contributed folder',
        linkedTask: CONTRIBUTED_LINKED_TASK
      },
      { runtimeEnvironmentId: 'env-1' }
    )

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'folderWorkspace.create',
        params: expect.objectContaining({ linkedTask: CONTRIBUTED_LINKED_TASK })
      })
    )
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('creates the folder workspace without the contributed link when the host lacks the capability', async () => {
    serveHostWithoutPluginProviderCapability()
    const folderWorkspace = makeFolderWorkspace(null)
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-create-folder',
      ok: true,
      result: { folderWorkspace },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()

    await expect(
      store.getState().createFolderWorkspace(
        {
          projectGroupId: projectGroup.id,
          name: 'Contributed folder',
          linkedTask: CONTRIBUTED_LINKED_TASK
        },
        { runtimeEnvironmentId: 'env-1' }
      )
    ).resolves.toEqual({ ...folderWorkspace, executionHostId: 'runtime:env-1' })

    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'folderWorkspace.create',
        params: expect.objectContaining({ linkedTask: undefined })
      })
    )
    expect(toast.warning).toHaveBeenCalledWith(
      'Linked item left off this workspace',
      expect.objectContaining({
        description: expect.stringContaining('too old to store links from installed plugins')
      })
    )
  })

  it('keeps a Linear linked task when the host lacks the plugin provider capability', async () => {
    serveHostWithoutPluginProviderCapability()
    const linkedTask: FolderWorkspace['linkedTask'] = {
      provider: 'linear',
      type: 'issue',
      number: 0,
      title: 'Refund fix',
      url: 'https://linear.app/acme/issue/ENG-123',
      linearIdentifier: 'ENG-123'
    }
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-create-folder',
      ok: true,
      result: { folderWorkspace: makeFolderWorkspace(linkedTask) },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()

    await store.getState().createFolderWorkspace(
      { projectGroupId: projectGroup.id, name: 'Contributed folder', linkedTask },
      { runtimeEnvironmentId: 'env-1' }
    )

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'folderWorkspace.create',
        params: expect.objectContaining({ linkedTask })
      })
    )
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('sends the contributed linked task through local folder-workspace creation', async () => {
    folderWorkspacesCreate.mockResolvedValue(makeFolderWorkspace(CONTRIBUTED_LINKED_TASK))
    const store = createTestStore()

    await store.getState().createFolderWorkspace({
      projectGroupId: projectGroup.id,
      name: 'Contributed folder',
      linkedTask: CONTRIBUTED_LINKED_TASK
    })

    expect(folderWorkspacesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ linkedTask: CONTRIBUTED_LINKED_TASK })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
  })
})
