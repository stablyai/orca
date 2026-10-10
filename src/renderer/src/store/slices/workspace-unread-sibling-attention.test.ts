import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { createTerminalTabAttentionActions } from '../terminals/terminal-tab-attention'
import { acknowledgeViewedAutoAckTarget } from '../../hooks/agent-auto-ack-surfaces'
import { makeUnifiedTab } from './store-test-helpers'
import { makeFolderWorkspace, makeTerminalTab, makeWorktree } from './worktrees-slice-test-fixtures'
import { createTestStore, mockApi, resetRemoteRuntimeMocks } from './worktrees-slice-test-harness'

const LEAF = '11111111-1111-4111-8111-111111111111'
const SIBLING_LEAF = '22222222-2222-4222-8222-222222222222'
const TAB = 'viewed-tab'
const SIBLING_TAB = 'sibling-tab'
const OWN_PANE = makePaneKey(TAB, LEAF)
const OTHER_PANE = makePaneKey(SIBLING_TAB, SIBLING_LEAF)
const SPLIT_PANE = makePaneKey(TAB, SIBLING_LEAF)

function seedWorkspace(kind: 'git' | 'folder') {
  const store = createTestStore()
  const folder = makeFolderWorkspace({ id: 'folder-attention', isUnread: true })
  const worktree = makeWorktree({ id: 'repo1::/repo/attention', repoId: 'repo1', isUnread: true })
  const workspaceId = kind === 'folder' ? folderWorkspaceKey(folder.id) : worktree.id
  store.setState({
    ...createTerminalTabAttentionActions(store.setState, store.getState),
    folderWorkspaces: kind === 'folder' ? [folder] : [],
    worktreesByRepo: { repo1: kind === 'git' ? [worktree] : [] },
    activeWorktreeId: workspaceId,
    activeTabId: TAB,
    ptyIdsByTabId: { [TAB]: ['pty-1'], [SIBLING_TAB]: ['pty-2'] },
    unverifiedPtyLossTabIds: {},
    tabsByWorktree: {
      [workspaceId]: [
        makeTerminalTab({ id: TAB, worktreeId: workspaceId }),
        makeTerminalTab({ id: SIBLING_TAB, worktreeId: workspaceId })
      ]
    },
    terminalLayoutsByTabId: {
      [TAB]: { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
    },
    unreadTerminalTabs: {},
    unreadTerminalPanes: {},
    unreadAgentCompletionPanes: {},
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    acknowledgedAgentsByPaneKey: {},
    manuallyUnreadTurnsByPaneKey: {}
  })
  const isUnread = () =>
    kind === 'folder'
      ? store.getState().folderWorkspaces[0].isUnread
      : store.getState().worktreesByRepo.repo1[0].isUnread
  return { store, workspaceId, isUnread, folderId: folder.id }
}

function interactWithPane(store: ReturnType<typeof createTestStore>, workspaceId: string) {
  store.getState().clearTerminalTabUnread(TAB)
  store.getState().clearTerminalPaneUnread(OWN_PANE)
  store.getState().clearWorktreeUnread(workspaceId)
}

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
})

describe.each(['git', 'folder'] as const)('%s workspace sibling attention', (kind) => {
  it('keeps the dot when input clears the viewed pane but another tab rang', () => {
    const { store, workspaceId, isUnread } = seedWorkspace(kind)
    store.setState({
      unreadTerminalTabs: { [TAB]: 'terminal-bell', [SIBLING_TAB]: 'terminal-bell' },
      unreadTerminalPanes: { [OWN_PANE]: 'terminal-bell', [OTHER_PANE]: 'terminal-bell' }
    })

    interactWithPane(store, workspaceId)

    expect(isUnread()).toBe(true)
    expect(store.getState().unreadTerminalPanes[OWN_PANE]).toBeUndefined()
    expect(store.getState().unreadTerminalTabs[TAB]).toBeUndefined()
    expect(store.getState().unreadTerminalPanes[OTHER_PANE]).toBe('terminal-bell')
    expect(store.getState().unreadTerminalTabs[SIBLING_TAB]).toBe('terminal-bell')
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
    expect(store.getState().updateFolderWorkspace).not.toHaveBeenCalled()
  })

  it('keeps the dot for a sibling pane after its tab marker is cleared', () => {
    const { store, workspaceId, isUnread } = seedWorkspace(kind)
    store.setState({
      unreadTerminalTabs: { [TAB]: 'terminal-bell' },
      unreadTerminalPanes: { [SPLIT_PANE]: 'terminal-bell' }
    })

    interactWithPane(store, workspaceId)

    expect(isUnread()).toBe(true)
    expect(store.getState().unreadTerminalPanes[SPLIT_PANE]).toBe('terminal-bell')
  })

  it.each(['tab', 'pane'] as const)('activation keeps sibling %s attention', (marker) => {
    const { store, workspaceId, isUnread, folderId } = seedWorkspace(kind)
    store.setState({
      unreadTerminalTabs: marker === 'tab' ? { [SIBLING_TAB]: 'terminal-bell' } : {},
      unreadAgentCompletionPanes: marker === 'pane' ? { [OTHER_PANE]: 'agent-completion' } : {}
    })

    store.getState().setActiveWorktree(workspaceId)
    if (kind === 'folder') {
      store.getState().setActiveFolderWorkspace(folderId)
    }

    expect(isUnread()).toBe(true)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
    expect(store.getState().updateFolderWorkspace).not.toHaveBeenCalled()
  })

  it('keeps the dot for an unread structured session beside the terminal', () => {
    const { store, workspaceId, isUnread } = seedWorkspace(kind)
    const chatSubject = structuredAgentSessionPaneKey('chat-tab', 'session-1')
    store.setState({
      unifiedTabsByWorktree: {
        [workspaceId]: [
          makeUnifiedTab({
            id: 'chat-tab',
            worktreeId: workspaceId,
            groupId: 'group-1',
            contentType: 'agent-session',
            entityId: 'session-1',
            agentSessionAgent: 'claude'
          })
        ]
      },
      unreadAgentCompletionPanes: { [chatSubject]: 'agent-completion' }
    })

    interactWithPane(store, workspaceId)

    expect(isUnread()).toBe(true)
    expect(store.getState().unreadAgentCompletionPanes[chatSubject]).toBe('agent-completion')
  })

  it('clears the dot when interaction clears the only pane attention', () => {
    const { store, workspaceId, isUnread } = seedWorkspace(kind)
    store.setState({
      unreadTerminalTabs: { [TAB]: 'terminal-bell' },
      unreadTerminalPanes: { [OWN_PANE]: 'terminal-bell' }
    })

    interactWithPane(store, workspaceId)

    expect(isUnread()).toBe(false)
    expect(store.getState().unreadTerminalPanes).toEqual({})
    expect(store.getState().unreadTerminalTabs).toEqual({})
  })

  it.each([false, true])(
    'auto acknowledgement clears its completion and preserves sibling bell=%s',
    (hasSibling) => {
      const { store, workspaceId, isUnread } = seedWorkspace(kind)
      store.setState({
        unreadAgentCompletionPanes: { [OWN_PANE]: 'agent-completion' },
        unreadTerminalPanes: hasSibling ? { [SPLIT_PANE]: 'terminal-bell' } : {}
      })

      acknowledgeViewedAutoAckTarget(store.getState(), {
        tabId: TAB,
        worktreeId: workspaceId,
        surfaceKind: 'terminal'
      })

      expect(isUnread()).toBe(hasSibling)
      expect(store.getState().unreadAgentCompletionPanes[OWN_PANE]).toBeUndefined()
      expect(store.getState().unreadTerminalPanes[SPLIT_PANE]).toBe(
        hasSibling ? 'terminal-bell' : undefined
      )
    }
  )

  it('ignores attention in another workspace and on closed tabs', () => {
    const { store, workspaceId, isUnread } = seedWorkspace(kind)
    store.setState({
      tabsByWorktree: {
        ...store.getState().tabsByWorktree,
        'remote-repo::/remote/workspace': [
          makeTerminalTab({ id: 'remote-tab', worktreeId: 'remote-repo::/remote/workspace' })
        ]
      },
      unreadTerminalTabs: { 'remote-tab': 'terminal-bell', 'closed-tab': 'terminal-bell' },
      unreadTerminalPanes: { [makePaneKey('remote-tab', LEAF)]: 'terminal-bell' }
    })

    store.getState().clearWorktreeUnread(workspaceId)

    expect(isUnread()).toBe(false)
    expect(store.getState().unreadTerminalTabs['remote-tab']).toBe('terminal-bell')
  })
})
