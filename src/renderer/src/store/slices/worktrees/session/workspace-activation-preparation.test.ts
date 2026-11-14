import { afterEach, expect, it, vi } from 'vitest'
import { installAttentionScreen } from '../../workspace-attention/workspace-unread-characterization-fixture'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import {
  markWorktreeSleepIntent,
  onWorktreeSleepIntentCleared,
  forgetWorktreeSleepIntent
} from '@/lib/workspace/sleep/worktree-sleep-intent'
import { createTestStore } from '../../../testing/app-store-test-fixture'
import { makeTab } from '../../../terminals/testing/terminal-tab.test-fixture'
import { makeWorktree } from '../worktree.test-fixture'
import { makeFolderWorkspace } from '../../../folder-workspaces/folder-workspace.test-fixture'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

const FOLDER_ID = 'folder-activation'
const FOLDER_KEY = folderWorkspaceKey(FOLDER_ID)
const WORKTREE_ID = 'worktree-activation'

afterEach(() => {
  forgetWorktreeSleepIntent(FOLDER_KEY)
  forgetWorktreeSleepIntent(WORKTREE_ID)
})

function seedWorkspace(kind: 'folder' | 'git', executionHostId: ExecutionHostId) {
  const store = createTestStore()
  const workspaceId = kind === 'folder' ? FOLDER_KEY : WORKTREE_ID
  store.setState({
    folderWorkspaces: [makeFolderWorkspace({ id: FOLDER_ID, executionHostId })],
    worktreesByRepo: {
      repo: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo', hostId: executionHostId })]
    },
    tabsByWorktree: {
      [workspaceId]: [
        makeTab({ id: 'terminal', worktreeId: workspaceId, ptyId: 'saved-session', generation: 3 })
      ]
    },
    activeTabIdByWorktree: { [workspaceId]: 'terminal' },
    everActivatedWorktreeIds: new Set([workspaceId]),
    rightSidebarExplorerView: 'search',
    rightSidebarExplorerViewByWorktree: { [workspaceId]: 'files' },
    refreshGitHubForWorktreeIfStale: vi.fn()
  })
  const activate = (): void => {
    if (kind === 'folder') {
      store.getState().setActiveFolderWorkspace(FOLDER_ID, executionHostId)
    } else {
      store.getState().setActiveWorktree(WORKTREE_ID, executionHostId)
    }
  }
  return { store, workspaceId, activate }
}

it('wakes slept folder on local after publishing restored explorer and terminal state', () => {
  const { store, workspaceId, activate } = seedWorkspace('folder', 'local')
  markWorktreeSleepIntent(workspaceId)
  const wake = vi.fn(() => {
    expect(store.getState().activeWorktreeId).toBe('folder:folder-activation')
    expect(store.getState().tabsByWorktree[workspaceId][0].generation).toBe(4)
    expect(store.getState().rightSidebarExplorerView).toBe('files')
  })
  onWorktreeSleepIntentCleared(workspaceId, wake)

  activate()

  expect(wake).toHaveBeenCalledOnce()
  expect(store.getState().activeWorkspaceExecutionHostId).toBe('local')
  expect(store.getState().tabsByWorktree[workspaceId][0].pendingActivationSpawn).toBe(true)
  expect(store.getState().activeTabId).toBe('terminal')
})

it('wakes slept git on ssh:remote after publishing restored explorer and terminal state', () => {
  const { store, workspaceId, activate } = seedWorkspace('git', 'ssh:remote')
  markWorktreeSleepIntent(workspaceId)
  const wake = vi.fn(() => {
    expect(store.getState().activeWorktreeId).toBe('worktree-activation')
    expect(store.getState().tabsByWorktree[workspaceId][0].generation).toBe(4)
    expect(store.getState().rightSidebarExplorerView).toBe('files')
  })
  onWorktreeSleepIntentCleared(workspaceId, wake)

  activate()

  expect(wake).toHaveBeenCalledOnce()
  expect(store.getState().activeWorkspaceExecutionHostId).toBe('ssh:remote')
  expect(store.getState().tabsByWorktree[workspaceId][0].pendingActivationSpawn).toBe(true)
  expect(store.getState().activeTabId).toBe('terminal')
})

it('reads only the selected folder owner on screen', () => {
  const { store, activate } = seedWorkspace('folder', 'ssh:remote')
  const updateFolderWorkspace = vi.fn().mockResolvedValue(null)
  store.setState({
    folderWorkspaces: [
      makeFolderWorkspace({ id: FOLDER_ID, executionHostId: 'local', isUnread: true }),
      makeFolderWorkspace({ id: FOLDER_ID, executionHostId: 'ssh:remote', isUnread: true })
    ],
    updateFolderWorkspace
  })

  installAttentionScreen(store, true)
  activate()

  expect(store.getState().folderWorkspaces.map((folder) => folder.isUnread)).toEqual([true, false])
})
