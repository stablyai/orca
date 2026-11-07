import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { FolderWorkspacePathStatusReason } from '../../../shared/folder-workspaces/folder-workspace-path-status'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import '../../../shared/constants'

// Drive real activation/store/path guarding; replace only singleton/toast/path IPC so mocking cannot hide dispatch or guard regressions.

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  getPathStatus: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: vi.fn() } }))

const { createTestStore } = await import('@/store/testing/app-store-test-fixture')
const store = createTestStore()

vi.mock('@/store', () => ({ useAppStore: store }))

const { activateAndRevealWorkspace } = await import('./workspace/activation/worktree-activation')

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

const folderWorkspace: FolderWorkspace = {
  id: 'folder-workspace-1',
  projectGroupId: projectGroup.id,
  name: 'Unmounted folder',
  folderPath: '/mnt/detached/project',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 1,
  lastActivityAt: 0,
  createdAt: 1,
  updatedAt: 1
}

async function seedFolderWorkspace(
  status: { exists: true } | { exists: false; reason: FolderWorkspacePathStatusReason }
): Promise<void> {
  store.setState({
    projectGroups: [projectGroup],
    folderWorkspaces: [folderWorkspace],
    activeWorktreeId: null,
    activeWorkspaceKey: null,
    activeView: 'terminal',
    sidebarBody: 'workspaces',
    folderWorkspacePathStatuses: {}
  })
  mocks.getPathStatus.mockResolvedValue({ path: folderWorkspace.folderPath, ...status })
  // Real fetch writes the exact cache key/request read by activation, preventing fixture drift.
  await store
    .getState()
    .fetchFolderWorkspacePathStatus(
      { scope: 'folder-workspace', folderWorkspaceId: folderWorkspace.id },
      { force: true, runtimeEnvironmentId: null }
    )
}

describe('Cmd/Ctrl+1-9 folder-workspace path gate (#10716)', () => {
  beforeEach(() => {
    store.setState(store.getInitialState(), true)
    mocks.toastError.mockClear()
    vi.stubGlobal('window', {
      api: { folderWorkspaces: { getPathStatus: mocks.getPathStatus } }
    })
  })

  it('blocks the number shortcut when the folder path is missing', async () => {
    await seedFolderWorkspace({ exists: false, reason: 'missing' })

    activateAndRevealWorkspace(folderWorkspaceKey(folderWorkspace.id))

    expect(store.getState().activeWorkspaceKey).toBeNull()
    expect(store.getState().activeWorktreeId).toBeNull()
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('still activates the number shortcut when the folder path is present', async () => {
    await seedFolderWorkspace({ exists: true })

    activateAndRevealWorkspace(folderWorkspaceKey(folderWorkspace.id))

    expect(store.getState().activeWorkspaceKey).toBe(folderWorkspaceKey(folderWorkspace.id))
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})
