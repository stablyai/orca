import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import {
  FOLDER_WORKSPACE_BACKEND_TEARDOWN_RUNTIME_CAPABILITY,
  FOLDER_WORKSPACE_OWNER_QUALIFIED_DELETE_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { FolderWorkspace, ProjectGroup } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponse,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const environmentId = 'legacy-environment'
const executionHostId = `runtime:${environmentId}` as const
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()
const folderWorkspacesDelete = vi.fn()
const projectGroupsDelete = vi.fn()
const projectGroupsList = vi.fn()

const projectGroup: ProjectGroup = {
  id: 'legacy-group',
  name: 'Legacy group',
  parentPath: '/workspace/legacy',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1,
  executionHostId
}

const folderWorkspace: FolderWorkspace = {
  id: 'legacy-folder',
  projectGroupId: projectGroup.id,
  name: 'Legacy folder',
  folderPath: '/workspace/legacy',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  createdAt: 1,
  updatedAt: 1,
  executionHostId
}

function legacyRuntimeStatus() {
  const status = createCompatibleRuntimeStatusResponse('legacy-runtime')
  if (status.ok) {
    status.result.capabilities = status.result.capabilities?.filter(
      (capability) =>
        capability !== FOLDER_WORKSPACE_BACKEND_TEARDOWN_RUNTIME_CAPABILITY &&
        capability !== FOLDER_WORKSPACE_OWNER_QUALIFIED_DELETE_RUNTIME_CAPABILITY
    )
  }
  return status
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  folderWorkspacesDelete.mockReset()
  projectGroupsDelete.mockReset()
  projectGroupsList.mockReset()
  vi.mocked(toast.error).mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
    args.method === 'status.get' ? legacyRuntimeStatus() : runtimeEnvironmentCall(args)
  )
  runtimeEnvironmentCall.mockResolvedValue({
    id: 'unexpected-rpc',
    ok: true,
    result: { deleted: true },
    _meta: { runtimeId: 'legacy-runtime' }
  })
  projectGroupsList.mockResolvedValue([])
  vi.stubGlobal('window', {
    api: {
      folderWorkspaces: { delete: folderWorkspacesDelete },
      projectGroups: { delete: projectGroupsDelete, list: projectGroupsList },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('legacy runtime folder workspace deletion gate', () => {
  it('keeps a folder when a legacy host may own terminals absent from renderer state', async () => {
    const store = createTestStore()
    store.setState({ projectGroups: [projectGroup], folderWorkspaces: [folderWorkspace] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(store.getState().deleteFolderWorkspace(folderWorkspace.id)).resolves.toBe(false)

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(folderWorkspacesDelete).not.toHaveBeenCalled()
    expect(store.getState().projectGroups).toEqual([projectGroup])
    expect(store.getState().folderWorkspaces).toEqual([folderWorkspace])
    expect(store.getState().tabsByWorktree).toEqual({})
    expect(warn).toHaveBeenCalledWith(
      'Folder workspace deletion requires backend terminal teardown support.'
    )
    expect(toast.error).toHaveBeenCalledWith('Failed to delete workspace', {
      description:
        'The older host runtime could not confirm terminal shutdown. The workspace was kept open; update the host and try again.',
      duration: 60_000
    })
    warn.mockRestore()
  })

  it('keeps a group when a legacy host may own headless folder terminals', async () => {
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: environmentId } as never,
      projectGroups: [projectGroup],
      folderWorkspaces: [folderWorkspace]
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(store.getState().deleteProjectGroup(projectGroup.id)).resolves.toBe(false)

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(projectGroupsDelete).not.toHaveBeenCalled()
    expect(store.getState().projectGroups).toEqual([projectGroup])
    expect(store.getState().folderWorkspaces).toEqual([folderWorkspace])
    expect(store.getState().tabsByWorktree).toEqual({})
    expect(warn).toHaveBeenCalledWith(
      'Project group deletion requires backend terminal teardown support.'
    )
    expect(toast.error).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
