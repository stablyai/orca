import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { FolderWorkspace } from '../../../shared/types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { useAppStore } from '@/store'
import { activateAndRevealFolderWorkspace } from './worktree-activation'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

function makeFolderWorkspace(): FolderWorkspace {
  return {
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'Platform',
    folderPath: '/workspace/platform',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

function seedFolderWorkspace(): {
  folderWorkspace: FolderWorkspace
  revealWorktreeInSidebar: ReturnType<typeof vi.fn>
} {
  const folderWorkspace = makeFolderWorkspace()
  const revealWorktreeInSidebar = vi.fn()

  useAppStore.setState({
    folderWorkspaces: [folderWorkspace],
    projectGroups: [],
    activeRepoId: null,
    activeWorktreeId: null,
    activeView: 'terminal',
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    openFiles: [],
    browserTabsByWorktree: {},
    activeFileIdByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    activeTabTypeByWorktree: {},
    activeTabIdByWorktree: {},
    tabBarOrderByWorktree: {},
    pendingStartupByTabId: {},
    settings: {
      ...getDefaultSettings('/tmp'),
      autoCreateTerminalOnWorkspaceActivation: false
    },
    getFreshFolderWorkspacePathStatus: vi.fn(() => null),
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    revealWorktreeInSidebar
  })

  return { folderWorkspace, revealWorktreeInSidebar }
}

describe('activateAndRevealFolderWorkspace', () => {
  it('leaves an empty folder workspace terminal-free when automatic creation is disabled', () => {
    const { folderWorkspace, revealWorktreeInSidebar } = seedFolderWorkspace()
    const workspaceKey = folderWorkspaceKey(folderWorkspace.id)

    const result = activateAndRevealFolderWorkspace(folderWorkspace.id, {
      runtimeEnvironmentId: null
    })

    expect(result).toEqual({ primaryTabId: null })
    expect(useAppStore.getState().tabsByWorktree[workspaceKey]).toBeUndefined()
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith(workspaceKey)
  })

  it('still creates a terminal for an explicit startup request', () => {
    const { folderWorkspace } = seedFolderWorkspace()

    const result = activateAndRevealFolderWorkspace(folderWorkspace.id, {
      runtimeEnvironmentId: null,
      startup: { command: 'echo ready' }
    })

    if (result === false || !result.primaryTabId) {
      throw new Error('explicit folder workspace startup did not create a terminal')
    }
    expect(useAppStore.getState().pendingStartupByTabId[result.primaryTabId]).toMatchObject({
      command: 'echo ready'
    })
  })
})
