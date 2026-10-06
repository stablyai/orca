import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  makeUnifiedTab,
  makeTabGroup,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/store-test-helpers'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'

vi.mock('@/store', () => ({ useAppStore: { getState: () => store.getState() } }))
vi.mock('./notification-runtime-navigation', () => ({
  activateNotificationRuntimeTarget: runtimeActivate
}))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane: terminalFocus }))
const { runtimeActivate, terminalFocus } = vi.hoisted(() => ({
  runtimeActivate: vi.fn(),
  terminalFocus: vi.fn()
}))
const store = createTestStore()
const { focusNotificationPaneAfterActivation } = await import('./notification-pane-focus')
const WORKSPACE = 'repo1::/tmp/chat'
const paneKey = structuredAgentSessionPaneKey('chat-tab', 'session-1')

function seed(workspaceId = WORKSPACE): void {
  store.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { repo1: [makeWorktree({ id: WORKSPACE, repoId: 'repo1' })] },
    folderWorkspaces: workspaceId.startsWith('folder:')
      ? [
          {
            id: 'folder-1',
            folderPath: '/tmp/chat',
            name: 'Chat',
            projectGroupId: 'project-1',
            executionHostId: 'local',
            linkedTask: null,
            comment: '',
            isArchived: false,
            isUnread: false,
            isPinned: false,
            sortOrder: 0,
            lastActivityAt: 1,
            createdAt: 1,
            updatedAt: 1
          }
        ]
      : [],
    refreshGitHubForWorktreeIfStale: vi.fn(),
    activeWorktreeId: workspaceId,
    unifiedTabsByWorktree: {
      [workspaceId]: [
        makeUnifiedTab({
          id: 'chat-tab',
          worktreeId: workspaceId,
          groupId: 'group-1',
          contentType: 'agent-session',
          entityId: 'session-1',
          executionHostId: 'local'
        })
      ]
    },
    groupsByWorktree: {
      [workspaceId]: [
        makeTabGroup({
          id: 'group-1',
          worktreeId: workspaceId,
          activeTabId: null,
          tabOrder: ['chat-tab']
        })
      ]
    },
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    activeGroupIdByWorktree: { [workspaceId]: 'group-1' }
  })
}

describe('native chat notification navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeActivate.mockResolvedValue(true)
    seed()
  })

  it.each([WORKSPACE, 'folder:folder-1'])(
    'reveals an existing chat without requiring a PTY in %s',
    async (worktreeId) => {
      seed(worktreeId)
      await focusNotificationPaneAfterActivation({
        worktreeId,
        notificationPaneKey: paneKey,
        notificationSurface: 'agent-session',
        executionHostId: 'local',
        isCurrentIntent: () => true
      })
      expect(store.getState().activeTabType).toBe('agent-session')
      expect(store.getState().groupsByWorktree[worktreeId]?.[0]?.activeTabId).toBe('chat-tab')
      expect(runtimeActivate).toHaveBeenCalledExactlyOnceWith({
        worktreeId,
        executionHostId: 'local',
        tabId: 'chat-tab'
      })
      expect(terminalFocus).not.toHaveBeenCalled()
    }
  )

  it('keeps a closed or rebound chat closed', async () => {
    const tab = store.getState().unifiedTabsByWorktree[WORKSPACE]?.[0]
    if (!tab) {
      throw new Error('missing test tab')
    }
    store.setState({
      unifiedTabsByWorktree: { [WORKSPACE]: [{ ...tab, entityId: 'different-session' }] }
    })
    await focusNotificationPaneAfterActivation({
      worktreeId: WORKSPACE,
      notificationPaneKey: paneKey,
      notificationSurface: 'agent-session',
      executionHostId: 'local',
      isCurrentIntent: () => true
    })
    expect(runtimeActivate).toHaveBeenCalledExactlyOnceWith({
      worktreeId: WORKSPACE,
      executionHostId: 'local'
    })
    expect(store.getState().groupsByWorktree[WORKSPACE]?.[0]?.activeTabId).toBeNull()
    expect(terminalFocus).not.toHaveBeenCalled()
  })

  it('does not reveal a chat superseded during host activation', async () => {
    let current = true
    runtimeActivate.mockImplementationOnce(async () => {
      current = false
      return true
    })
    await focusNotificationPaneAfterActivation({
      worktreeId: WORKSPACE,
      notificationPaneKey: paneKey,
      notificationSurface: 'agent-session',
      executionHostId: 'local',
      isCurrentIntent: () => current
    })
    expect(store.getState().groupsByWorktree[WORKSPACE]?.[0]?.activeTabId).toBeNull()
  })
})
