import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { buildWorkspaceSessionPayload } from '../../lib/workspace-session'
import { createStoreSessionMockApi } from './store-session-test-harness'
import { createTestStore, makeWorktree } from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

const WORKTREE_ID = 'repo-1::/workspace'
const FILE_PATH = '/workspace/.scratch/preview.png'
const SSH_FOLDER_ID = 'ssh-folder'
const SSH_FOLDER_KEY = folderWorkspaceKey(SSH_FOLDER_ID)
const SSH_FILE_PATH = '/srv/workspace/.scratch/preview.png'

function prepareStore() {
  const store = createTestStore()
  store.setState({
    repos: [
      { id: 'repo-1', path: '/workspace', displayName: 'Repo', badgeColor: '#000', addedAt: 0 }
    ],
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: WORKTREE_ID, repoId: 'repo-1', path: '/workspace' })]
    },
    activeWorktreeId: WORKTREE_ID
  })
  return store
}

function prepareSshFolderStore() {
  const store = createTestStore()
  store.setState({
    folderWorkspaces: [
      {
        id: SSH_FOLDER_ID,
        projectGroupId: 'ssh-project',
        name: 'SSH folder',
        folderPath: '/srv/workspace',
        connectionId: 'ssh-target',
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        createdAt: 1,
        updatedAt: 1
      }
    ],
    activeWorktreeId: SSH_FOLDER_KEY
  })
  return store
}

function corruptSession(worktreeId = WORKTREE_ID, filePath = FILE_PATH): WorkspaceSessionState {
  const persistedFile = {
    filePath,
    relativePath: '.scratch/preview.png',
    worktreeId,
    language: 'image'
  }
  const editorTab = (id: string, sortOrder: number) => ({
    id,
    entityId: filePath,
    groupId: 'group-restored',
    worktreeId,
    contentType: 'editor' as const,
    label: 'preview.png',
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: 1_788_002_466_152
  })
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: worktreeId,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    openFilesByWorktree: {
      [worktreeId]: [persistedFile, { ...persistedFile }, { ...persistedFile }]
    },
    activeFileIdByWorktree: { [worktreeId]: `editor:stale-pane:${filePath}` },
    activeTabTypeByWorktree: { [worktreeId]: 'editor' },
    unifiedTabs: {
      [worktreeId]: [editorTab('editor-restored-a', 0), editorTab('editor-restored-b', 1)]
    },
    tabGroups: {
      [worktreeId]: [
        {
          id: 'group-restored',
          worktreeId,
          activeTabId: `editor:third-pane:${filePath}`,
          tabOrder: [`editor:third-pane:${filePath}`]
        }
      ]
    },
    activeGroupIdByWorktree: { [worktreeId]: 'group-restored' }
  }
}

function closeAndRestart(
  prepare: typeof prepareStore,
  session: WorkspaceSessionState,
  workspaceId: string
) {
  const store = prepare()
  store.getState().hydrateTabsSession(session)
  store.getState().hydrateEditorSession(session)

  expect.soft(store.getState().openFiles).toHaveLength(1)
  expect.soft(store.getState().unifiedTabsByWorktree[workspaceId]).toHaveLength(1)

  const activeFileId = store.getState().activeFileIdByWorktree[workspaceId]
  expect(activeFileId).toBeTruthy()
  store.getState().closeFile(activeFileId!)

  const persistedAfterClose = buildWorkspaceSessionPayload(store.getState())
  const restartedStore = prepare()
  restartedStore.getState().hydrateTabsSession(persistedAfterClose)
  restartedStore.getState().hydrateEditorSession(persistedAfterClose)
  return restartedStore.getState()
}

describe('corrupt editor session restore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not preserve duplicate records that resurrect a closed editor', () => {
    const restarted = closeAndRestart(prepareStore, corruptSession(), WORKTREE_ID)
    expect(restarted.openFiles).toEqual([])
    expect(restarted.unifiedTabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
  })

  it('cleans the same corruption for an SSH-hosted folder workspace', () => {
    const restarted = closeAndRestart(
      prepareSshFolderStore,
      corruptSession(SSH_FOLDER_KEY, SSH_FILE_PATH),
      SSH_FOLDER_KEY
    )
    expect(restarted.openFiles).toEqual([])
    expect(restarted.unifiedTabsByWorktree[SSH_FOLDER_KEY] ?? []).toEqual([])
  })

  it('rewrites group references from a duplicate editor row to the survivor', () => {
    const store = prepareStore()
    const session = corruptSession()
    session.tabGroups![WORKTREE_ID]![0] = {
      ...session.tabGroups![WORKTREE_ID]![0],
      activeTabId: 'editor-restored-b',
      tabOrder: ['editor-restored-b'],
      recentTabIds: ['editor-restored-b']
    }

    store.getState().hydrateTabsSession(session)

    expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID].map((tab) => tab.id)).toEqual([
      'editor-restored-a'
    ])
    expect(store.getState().groupsByWorktree[WORKTREE_ID][0]).toEqual(
      expect.objectContaining({
        activeTabId: 'editor-restored-a',
        tabOrder: ['editor-restored-a'],
        recentTabIds: ['editor-restored-a']
      })
    )
  })

  it('does not redirect a stale alias reference into another group', () => {
    const store = prepareStore()
    const session = corruptSession()
    const [left, right] = session.unifiedTabs![WORKTREE_ID]!
    session.unifiedTabs![WORKTREE_ID] = [
      { ...left, id: 'editor-group-a-left', groupId: 'group-a' },
      { ...right, id: 'editor-group-a-duplicate', groupId: 'group-a' },
      {
        ...right,
        id: 'editor-group-b',
        entityId: '/workspace/.scratch/other.png',
        groupId: 'group-b',
        label: 'other.png',
        sortOrder: 2
      }
    ]
    session.tabGroups![WORKTREE_ID] = [
      {
        id: 'group-a',
        worktreeId: WORKTREE_ID,
        activeTabId: 'editor-group-a-duplicate',
        tabOrder: ['editor-group-a-left', 'editor-group-a-duplicate']
      },
      {
        id: 'group-b',
        worktreeId: WORKTREE_ID,
        activeTabId: 'editor-group-b',
        // This stale reference must not be rewritten with group-a's alias.
        tabOrder: ['editor-group-a-duplicate', 'editor-group-b']
      }
    ]

    store.getState().hydrateTabsSession(session)

    expect(store.getState().groupsByWorktree[WORKTREE_ID]).toEqual([
      expect.objectContaining({ id: 'group-a', tabOrder: ['editor-group-a-left'] }),
      expect.objectContaining({ id: 'group-b', tabOrder: ['editor-group-b'] })
    ])
  })

  it('preserves shared editor entities in separate split groups', () => {
    const store = prepareStore()
    const session = corruptSession()
    const [left, right] = session.unifiedTabs![WORKTREE_ID]!
    session.unifiedTabs![WORKTREE_ID] = [
      { ...left, id: 'editor-left', groupId: 'group-left' },
      { ...right, id: 'editor-right', groupId: 'group-right' }
    ]
    session.tabGroups![WORKTREE_ID] = [
      {
        id: 'group-left',
        worktreeId: WORKTREE_ID,
        activeTabId: 'editor-left',
        tabOrder: ['editor-left']
      },
      {
        id: 'group-right',
        worktreeId: WORKTREE_ID,
        activeTabId: 'editor-right',
        tabOrder: ['editor-right']
      }
    ]

    store.getState().hydrateTabsSession(session)
    store.getState().hydrateEditorSession(session)

    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID].map((tab) => tab.id)).toEqual([
      'editor-left',
      'editor-right'
    ])
  })

  it('does not let a globally duplicated id hydrate into another group', () => {
    const store = prepareStore()
    const session = corruptSession()
    session.unifiedTabs![WORKTREE_ID] = [
      {
        ...session.unifiedTabs![WORKTREE_ID]![0],
        id: 'shared-id',
        entityId: '/workspace/.scratch/group-a.png',
        groupId: 'group-a',
        label: 'group-a.png',
        sortOrder: 0
      },
      {
        ...session.unifiedTabs![WORKTREE_ID]![1],
        id: 'shared-id',
        entityId: '/workspace/.scratch/group-b.png',
        groupId: 'group-b',
        label: 'group-b.png',
        sortOrder: 1
      },
      {
        ...session.unifiedTabs![WORKTREE_ID]![1],
        id: 'group-b-only',
        entityId: '/workspace/.scratch/group-b-only.png',
        groupId: 'group-b',
        label: 'group-b-only.png',
        sortOrder: 2
      }
    ]
    session.tabGroups![WORKTREE_ID] = [
      {
        id: 'group-a',
        worktreeId: WORKTREE_ID,
        activeTabId: 'shared-id',
        tabOrder: ['shared-id']
      },
      {
        id: 'group-b',
        worktreeId: WORKTREE_ID,
        activeTabId: 'shared-id',
        tabOrder: ['shared-id', 'group-b-only']
      }
    ]

    store.getState().hydrateTabsSession(session)

    expect(store.getState().groupsByWorktree[WORKTREE_ID]).toEqual([
      expect.objectContaining({ id: 'group-a', tabOrder: ['shared-id'] }),
      expect.objectContaining({ id: 'group-b', tabOrder: ['group-b-only'], activeTabId: null })
    ])
  })

  it('keeps a stale cross-group reference away from a surviving declared owner', () => {
    const store = prepareStore()
    const session = corruptSession()
    session.unifiedTabs![WORKTREE_ID] = [
      {
        ...session.unifiedTabs![WORKTREE_ID]![0],
        id: 'shared-id',
        entityId: '/workspace/.scratch/shared.png',
        groupId: 'group-a',
        label: 'shared.png',
        sortOrder: 0
      },
      {
        ...session.unifiedTabs![WORKTREE_ID]![0],
        id: 'group-a-only',
        entityId: '/workspace/.scratch/group-a-only.png',
        groupId: 'group-a',
        label: 'group-a-only.png',
        sortOrder: 1
      },
      {
        ...session.unifiedTabs![WORKTREE_ID]![1],
        id: 'group-b-only',
        entityId: '/workspace/.scratch/group-b-only.png',
        groupId: 'group-b',
        label: 'group-b-only.png',
        sortOrder: 2
      }
    ]
    session.tabGroups![WORKTREE_ID] = [
      {
        id: 'group-b',
        worktreeId: WORKTREE_ID,
        activeTabId: 'shared-id',
        tabOrder: ['shared-id', 'group-b-only']
      },
      {
        id: 'group-a',
        worktreeId: WORKTREE_ID,
        activeTabId: 'group-a-only',
        tabOrder: ['group-a-only']
      }
    ]

    store.getState().hydrateTabsSession(session)

    expect(store.getState().groupsByWorktree[WORKTREE_ID]).toEqual([
      expect.objectContaining({ id: 'group-b', tabOrder: ['group-b-only'], activeTabId: null }),
      expect.objectContaining({
        id: 'group-a',
        tabOrder: ['group-a-only', 'shared-id'],
        activeTabId: 'group-a-only'
      })
    ])
  })
})
