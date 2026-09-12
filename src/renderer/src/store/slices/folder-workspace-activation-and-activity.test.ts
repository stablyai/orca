import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

const folderWorkspacesUpdate = vi.fn()
const folderWorkspacesList = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

const projectGroup: ProjectGroup = {
  id: 'group-1',
  name: 'Platform',
  parentPath: '/workspace/platform',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: projectGroup.id,
    name: 'Folder workspace',
    folderPath: '/workspace/folder',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function rememberedBrowserSurface(workspaceKey: string): Partial<AppState> {
  return {
    browserTabsByWorktree: {
      [workspaceKey]: [
        {
          id: 'remembered',
          worktreeId: workspaceKey,
          url: 'about:blank',
          title: 'Browser',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
      ]
    },
    activeBrowserTabIdByWorktree: { [workspaceKey]: 'remembered' },
    activeTabTypeByWorktree: { [workspaceKey]: 'browser' }
  }
}

type FolderWorkspaceUpdateArgs = {
  folderWorkspaceId: string
  updates: Partial<FolderWorkspace>
}

function stubFolderWorkspaceApis(): void {
  clearRuntimeCompatibilityCacheForTests()
  folderWorkspacesUpdate.mockReset()
  folderWorkspacesList.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      folderWorkspaces: {
        update: folderWorkspacesUpdate,
        list: folderWorkspacesList
      },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
}

function seedLocalFolderStore(folderWorkspace: FolderWorkspace) {
  const store = createTestStore()
  store.setState({
    projectGroups: [{ ...projectGroup, executionHostId: 'local' }],
    folderWorkspaces: [folderWorkspace],
    refreshGitHubForWorktreeIfStale: vi.fn()
  } as Partial<AppState>)
  return store
}

function respondWithUpdates(base: FolderWorkspace) {
  return async (args: FolderWorkspaceUpdateArgs): Promise<FolderWorkspace> => ({
    ...base,
    ...args.updates,
    updatedAt: Math.max(base.updatedAt + 1, Date.now())
  })
}

beforeEach(() => {
  stubFolderWorkspaceApis()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('folder workspace generic activation and activity', () => {
  it('publishes folder-scoped active state and clears unread immediately', async () => {
    const folderWorkspace = makeFolderWorkspace({ isUnread: true })
    const workspaceKey = folderWorkspaceKey(folderWorkspace.id)
    folderWorkspacesUpdate.mockImplementation(respondWithUpdates(folderWorkspace))
    const store = seedLocalFolderStore(folderWorkspace)

    store.getState().setActiveWorktree(workspaceKey)
    await Promise.resolve()

    expect(store.getState()).toMatchObject({
      activeRepoId: null,
      activeWorktreeId: workspaceKey,
      activeWorkspaceKey: workspaceKey
    })
    expect(store.getState().folderWorkspaces[0]?.isUnread).toBe(false)
    expect(folderWorkspacesUpdate).toHaveBeenCalledWith({
      folderWorkspaceId: folderWorkspace.id,
      updates: { isUnread: false }
    })
  })

  it.each([
    ['simulator', 'local'],
    ['agent-session', 'local'],
    ['simulator', 'ssh:test-host'],
    ['agent-session', 'ssh:test-host']
  ] as const)(
    'restores a folder %s tab on %s using its concrete visible type',
    (contentType, executionHostId) => {
      const folder = makeFolderWorkspace({ executionHostId })
      const workspaceKey = folderWorkspaceKey(folder.id)
      const store = seedLocalFolderStore(folder)
      store.getState().createUnifiedTab(workspaceKey, contentType, { id: 'selected' })
      store.setState({ activeTabTypeByWorktree: { [workspaceKey]: 'editor' } })

      store.getState().setActiveFolderWorkspace(folder.id, executionHostId)

      expect(store.getState().activeWorkspaceExecutionHostId).toBe(executionHostId)
      expect(store.getState().activeTabType).toBe(contentType)
      expect(store.getState().activeTabTypeByWorktree[workspaceKey]).toBe(contentType)
      expect(store.getState().getActiveTab(workspaceKey)?.id).toBe('selected')
    }
  )

  it('does not let remembered browser state select content in an empty folder group', () => {
    const folder = makeFolderWorkspace()
    const workspaceKey = folderWorkspaceKey(folder.id)
    const store = seedLocalFolderStore(folder)
    store.setState({
      ...rememberedBrowserSurface(workspaceKey),
      groupsByWorktree: {
        [workspaceKey]: [
          {
            id: 'empty',
            worktreeId: workspaceKey,
            activeTabId: null,
            tabOrder: []
          }
        ]
      },
      activeGroupIdByWorktree: { [workspaceKey]: 'empty' }
    } as Partial<AppState>)

    store.getState().setActiveFolderWorkspace(folder.id)

    expect(store.getState().activeTabType).toBe('terminal')
    expect(store.getState().activeBrowserTabId).toBe('remembered')
  })

  it('keeps layout-only folder ownership above remembered browser state', () => {
    const folder = makeFolderWorkspace()
    const workspaceKey = folderWorkspaceKey(folder.id)
    const store = seedLocalFolderStore(folder)
    store.setState({
      ...rememberedBrowserSurface(workspaceKey),
      groupsByWorktree: {},
      layoutByWorktree: { [workspaceKey]: { type: 'leaf', groupId: 'pending' } }
    } as Partial<AppState>)

    store.getState().setActiveFolderWorkspace(folder.id)

    expect(store.getState().activeTabType).toBe('terminal')
    expect(store.getState().activeBrowserTabId).toBe('remembered')
  })

  it('falls back to an open file when nothing else owns the folder surface', () => {
    const folder = makeFolderWorkspace()
    const workspaceKey = folderWorkspaceKey(folder.id)
    const store = seedLocalFolderStore(folder)
    store.setState({
      groupsByWorktree: {},
      layoutByWorktree: {},
      // Why: the remembered browser tab is gone, so only the open file is left to show.
      activeBrowserTabIdByWorktree: { [workspaceKey]: 'closed' },
      browserTabsByWorktree: { [workspaceKey]: [] },
      activeTabTypeByWorktree: { [workspaceKey]: 'browser' },
      openFiles: [
        {
          id: 'fallback-file',
          worktreeId: workspaceKey,
          filePath: '/workspace/folder/file',
          relativePath: 'file',
          language: 'plaintext',
          isDirty: false,
          mode: 'edit'
        }
      ]
    } as Partial<AppState>)

    store.getState().setActiveFolderWorkspace(folder.id)

    expect(store.getState().activeTabType).toBe('editor')
    expect(store.getState().activeFileId).toBe('fallback-file')
  })

  it('coalesces repeated activity persistence while keeping local activity current', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const folderWorkspace = makeFolderWorkspace()
    const workspaceKey = folderWorkspaceKey(folderWorkspace.id)
    let resolveFirst!: (workspace: FolderWorkspace) => void
    folderWorkspacesUpdate
      .mockImplementationOnce(
        () =>
          new Promise<FolderWorkspace>((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockImplementation(respondWithUpdates(folderWorkspace))
    const store = seedLocalFolderStore(folderWorkspace)

    store.getState().bumpWorktreeActivity(workspaceKey)
    await vi.advanceTimersByTimeAsync(100)
    store.getState().bumpWorktreeActivity(workspaceKey)
    await vi.advanceTimersByTimeAsync(100)
    store.getState().bumpWorktreeActivity(workspaceKey)

    expect(store.getState().folderWorkspaces[0]?.lastActivityAt).toBe(1_200)
    expect(folderWorkspacesUpdate).toHaveBeenCalledTimes(1)
    expect(folderWorkspacesUpdate).toHaveBeenLastCalledWith({
      folderWorkspaceId: folderWorkspace.id,
      updates: { lastActivityAt: 1_000 }
    })

    // Why: the first IPC must not rewind local activity that advanced while it was in flight.
    resolveFirst({
      ...folderWorkspace,
      lastActivityAt: 1_000,
      updatedAt: 2
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(store.getState().folderWorkspaces[0]?.lastActivityAt).toBe(1_200)

    await vi.advanceTimersByTimeAsync(800)

    expect(folderWorkspacesUpdate).toHaveBeenCalledTimes(2)
    expect(folderWorkspacesUpdate).toHaveBeenLastCalledWith({
      folderWorkspaceId: folderWorkspace.id,
      updates: { lastActivityAt: 1_200 }
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getState().folderWorkspaces[0]?.lastActivityAt).toBe(1_200)
  })

  it('does not rewind local activity when a failed early persist reconciles an older catalog value', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const folderWorkspace = makeFolderWorkspace()
    const workspaceKey = folderWorkspaceKey(folderWorkspace.id)
    let rejectFirst!: (error: Error) => void
    folderWorkspacesUpdate
      .mockImplementationOnce(
        () =>
          new Promise<FolderWorkspace>((_resolve, reject) => {
            rejectFirst = reject
          })
      )
      .mockImplementation(respondWithUpdates(folderWorkspace))
    folderWorkspacesList.mockResolvedValue([
      { ...folderWorkspace, lastActivityAt: 1_000, updatedAt: 2 }
    ])
    const store = seedLocalFolderStore(folderWorkspace)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      store.getState().bumpWorktreeActivity(workspaceKey)
      await vi.advanceTimersByTimeAsync(100)
      store.getState().bumpWorktreeActivity(workspaceKey)
      expect(store.getState().folderWorkspaces[0]?.lastActivityAt).toBe(1_100)

      rejectFirst(new Error('persist failed'))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(folderWorkspacesList).toHaveBeenCalled()
      expect(store.getState().folderWorkspaces[0]?.lastActivityAt).toBe(1_100)
    } finally {
      errorSpy.mockRestore()
    }
  })
})
