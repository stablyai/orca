import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { FolderWorkspacePathStatusReason } from '../../../shared/folder-workspace-path-status'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { getDefaultSettings } from '../../../shared/constants'
import { getFolderWorkspaceStatusRequestSnapshot } from '@/store/folder-workspaces/folder-path-status'
import { makeGroup, makeUnifiedTab } from '@/components/worktree-jump-palette-test-fixtures'

// Drive real activation/store/path guarding; replace only singleton/toast/path IPC so mocking cannot hide dispatch or guard regressions.

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  getPathStatus: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: vi.fn() } }))

const { createTestStore } = await import('@/store/slices/store-test-helpers')
const store = createTestStore()

vi.mock('@/store', () => ({ useAppStore: store }))

const { activateAndRevealWorkspace } = await import('./worktree-activation')
const { activateWorkspaceTabPaletteResult } = await import('./workspace-tab-palette-activation')
const { activateBrowserPagePaletteResult } = await import('./browser-page-palette-activation')
const { activateSimulatorTabPaletteResult } = await import('./simulator-tab-palette-activation')

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

  it('blocks the number shortcut when the SSH connection owning the folder is ambiguous', async () => {
    await seedFolderWorkspace({ exists: false, reason: 'ambiguous-connection' })

    activateAndRevealWorkspace(folderWorkspaceKey(folderWorkspace.id))

    expect(store.getState().activeWorkspaceKey).toBeNull()
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('still activates the number shortcut when the folder path is present', async () => {
    await seedFolderWorkspace({ exists: true })

    activateAndRevealWorkspace(folderWorkspaceKey(folderWorkspace.id))

    expect(store.getState().activeWorkspaceKey).toBe(folderWorkspaceKey(folderWorkspace.id))
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it.each(['local', 'runtime:builder'] as const)(
    'keeps the selected %s host on a folder sidebar reveal',
    async (executionHostId) => {
      await seedFolderWorkspace({ exists: true })
      store.setState({
        folderWorkspaces: [
          {
            ...folderWorkspace,
            executionHostId: executionHostId === 'local' ? 'runtime:builder' : 'local'
          },
          { ...folderWorkspace, executionHostId }
        ]
      })

      activateAndRevealWorkspace(folderWorkspaceKey(folderWorkspace.id), {
        executionHostId,
        providesInitialSurface: true
      })

      expect(store.getState().pendingRevealWorktree).toMatchObject({
        worktreeId: folderWorkspaceKey(folderWorkspace.id),
        executionHostId
      })
    }
  )

  it.each([
    ['local', null],
    ['ssh:builder', 'builder']
  ] as const)(
    'reveals the %s catalog owner when an unrelated server is focused',
    async (executionHostId, connectionId) => {
      await seedFolderWorkspace({ exists: true })
      store.setState({
        projectGroups: [{ ...projectGroup, connectionId }],
        settings: {
          ...getDefaultSettings('/tmp'),
          activeRuntimeEnvironmentId: 'focused-server'
        }
      })

      activateAndRevealWorkspace(folderWorkspaceKey(folderWorkspace.id), {
        providesInitialSurface: true
      })

      expect(store.getState().pendingRevealWorktree).toMatchObject({
        worktreeId: folderWorkspaceKey(folderWorkspace.id),
        executionHostId
      })
    }
  )

  it.each(['local', 'runtime:builder'] as const)(
    'checks the selected %s folder when the same id is active on another host',
    async (executionHostId) => {
      await seedFolderWorkspace({ exists: true })
      const workspaceKey = folderWorkspaceKey(folderWorkspace.id)
      store.setState({
        folderWorkspaces: [
          { ...folderWorkspace, executionHostId: 'local' },
          { ...folderWorkspace, executionHostId: 'runtime:builder', folderPath: '/srv/project' }
        ],
        activeWorktreeId: workspaceKey,
        activeWorkspaceExecutionHostId: executionHostId === 'local' ? 'runtime:builder' : 'local'
      })
      const request = { scope: 'folder-workspace', folderWorkspaceId: folderWorkspace.id } as const
      const runtimeEnvironmentId = executionHostId === 'local' ? null : 'builder'
      const requestSnapshot = getFolderWorkspaceStatusRequestSnapshot(store.getState(), request, {
        runtimeEnvironmentId
      })
      if (requestSnapshot === null) {
        throw new Error('The folder fixture must have a path snapshot')
      }
      const cacheKey = store
        .getState()
        .getFolderWorkspacePathStatusCacheKey(request, { runtimeEnvironmentId })
      store.setState({
        folderWorkspacePathStatuses: {
          ...store.getState().folderWorkspacePathStatuses,
          [cacheKey]: {
            checkedAt: Date.now(),
            requestSnapshot,
            status: { path: '/selected/missing', exists: false, reason: 'missing' }
          }
        }
      })
      const before = store.getState()

      expect(activateAndRevealWorkspace(workspaceKey, { executionHostId })).toBe(false)
      expect(store.getState()).toBe(before)
      expect(mocks.toastError).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['terminal', 'browser', 'simulator'] as const)(
    'preserves the path error for a blocked folder %s jump',
    async (contentType) => {
      await seedFolderWorkspace({ exists: false, reason: 'missing' })
      const worktreeId = folderWorkspaceKey(folderWorkspace.id)
      const tab = { ...makeUnifiedTab('tab-1', worktreeId, 'entity-1', 'Research'), contentType }
      store.setState({
        unifiedTabsByWorktree: { [worktreeId]: [tab] },
        groupsByWorktree: { [worktreeId]: [makeGroup(worktreeId, [tab.id])] },
        browserTabsByWorktree: {
          [worktreeId]: [
            {
              id: 'entity-1',
              worktreeId,
              url: 'https://example.com',
              title: 'Research',
              loading: false,
              faviconUrl: null,
              canGoBack: false,
              canGoForward: false,
              loadError: null,
              createdAt: 0
            }
          ]
        },
        browserPagesByWorkspace: {
          'entity-1': [
            {
              id: 'page-1',
              worktreeId,
              workspaceId: 'entity-1',
              url: 'https://example.com',
              title: 'Research',
              loading: false,
              faviconUrl: null,
              canGoBack: false,
              canGoForward: false,
              loadError: null,
              createdAt: 0
            }
          ]
        }
      })
      const before = store.getState()
      const result =
        contentType === 'terminal'
          ? activateWorkspaceTabPaletteResult({
              worktreeId,
              contentType,
              tabId: tab.id,
              entityId: tab.entityId,
              groupId: tab.groupId
            })
          : contentType === 'browser'
            ? activateBrowserPagePaletteResult({
                worktreeId,
                pageId: 'page-1',
                workspaceId: tab.entityId
              })
            : activateSimulatorTabPaletteResult({ worktreeId, tabId: tab.id })

      expect(result).toEqual({ status: 'blocked' })
      expect(store.getState()).toBe(before)
      expect(mocks.toastError).toHaveBeenCalledTimes(1)
      expect(mocks.toastError).toHaveBeenCalledWith('Folder not found', expect.anything())
    }
  )
})
