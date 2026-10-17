import { afterEach, expect, it, vi } from 'vitest'
import { installAttentionScreen } from './workspace-attention/workspace-unread-characterization-fixture'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  markWorktreeSleepIntent,
  onWorktreeSleepIntentCleared,
  forgetWorktreeSleepIntent
} from '@/lib/worktree-sleep-intent'
import { createTestStore, makeTab, makeWorktree } from './store-test-helpers'
import { makeFolderWorkspace } from './worktrees-slice-test-fixtures'

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

it.each([
  ['folder', 'local'],
  ['git', 'local'],
  ['folder', 'ssh:remote'],
  ['git', 'ssh:remote']
] as const)('wakes a slept %s on %s and restores its explorer mode atomically', (kind, hostId) => {
  const { store, workspaceId, activate } = seedWorkspace(kind, hostId)
  markWorktreeSleepIntent(workspaceId, hostId)
  const wake = vi.fn(() => {
    expect(store.getState().activeWorktreeId).toBe(workspaceId)
    expect(store.getState().tabsByWorktree[workspaceId][0].generation).toBe(4)
    expect(store.getState().rightSidebarExplorerView).toBe('files')
  })
  onWorktreeSleepIntentCleared(workspaceId, wake)

  activate()

  expect(wake).toHaveBeenCalledOnce()
  expect(store.getState().activeWorkspaceExecutionHostId).toBe(hostId)
  expect(store.getState().tabsByWorktree[workspaceId][0].pendingActivationSpawn).toBeDefined()
  expect(store.getState().activeTabId).toBe('terminal')
  expect(store.getState().refreshGitHubForWorktreeIfStale).toHaveBeenCalledTimes(
    kind === 'git' ? 1 : 0
  )
})

it.each(['folder', 'git'] as const)('preserves a live %s terminal on repeat activation', (kind) => {
  const { store, workspaceId, activate } = seedWorkspace(kind, 'local')
  store.setState({ ptyIdsByTabId: { terminal: ['live-pty'] } })
  activate()
  const activated = store.getState()

  activate()

  expect(store.getState()).toBe(activated)
  expect(store.getState().tabsByWorktree[workspaceId][0].generation).toBe(3)
})

it.each(['folder', 'git'] as const)(
  'wakes an already-selected %s after its PTY is released',
  (kind) => {
    const { store, workspaceId, activate } = seedWorkspace(kind, 'local')
    store.setState({ ptyIdsByTabId: { terminal: ['live-pty'] } })
    activate()
    store.setState({ ptyIdsByTabId: {} })

    activate()

    expect(store.getState().tabsByWorktree[workspaceId][0].generation).toBe(4)
  }
)

it('reads only the selected folder owner on screen and persists to that host', () => {
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
  expect(updateFolderWorkspace).toHaveBeenCalledWith(
    FOLDER_ID,
    { isUnread: false },
    { executionHostId: 'ssh:remote' }
  )
})

it('leaves selection unchanged when the requested folder owner is absent', () => {
  const { store } = seedWorkspace('folder', 'local')
  const before = store.getState()

  store.getState().setActiveFolderWorkspace(FOLDER_ID, 'ssh:missing')

  expect(store.getState()).toBe(before)
})
