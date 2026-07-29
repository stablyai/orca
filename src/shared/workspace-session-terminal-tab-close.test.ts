import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from './constants'
import type { Tab, TerminalTab, WorkspaceSessionState } from './types'
import { closeTerminalTabInWorkspaceSession } from './workspace-session-terminal-tab-close'

const WORKTREE_ID = 'worktree-1'

function terminalTab(id: string, ptyId: string | null, isPinned = false): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: WORKTREE_ID,
    title: id,
    customTitle: null,
    color: null,
    isPinned,
    sortOrder: 0,
    createdAt: 1
  }
}

function unifiedTab(
  id: string,
  entityId: string,
  contentType: Tab['contentType'],
  groupId = 'group-1',
  isPinned = false
): Tab {
  return {
    id,
    entityId,
    groupId,
    worktreeId: WORKTREE_ID,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    isPinned
  }
}

function session(overrides: Partial<WorkspaceSessionState> = {}): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: WORKTREE_ID,
    activeTabId: 'terminal-1',
    tabsByWorktree: {
      [WORKTREE_ID]: [terminalTab('terminal-1', 'pty-left')]
    },
    terminalLayoutsByTabId: {
      'terminal-1': {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: 'leaf-left' },
          second: { type: 'leaf', leafId: 'leaf-right' }
        },
        activeLeafId: 'leaf-left',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-left': 'pty-left', 'leaf-right': 'pty-right' }
      }
    },
    activeTabIdByWorktree: { [WORKTREE_ID]: 'terminal-1' },
    unifiedTabs: {
      [WORKTREE_ID]: [unifiedTab('terminal-1', 'terminal-1', 'terminal')]
    },
    tabGroups: {
      [WORKTREE_ID]: [
        {
          id: 'group-1',
          worktreeId: WORKTREE_ID,
          activeTabId: 'terminal-1',
          tabOrder: ['terminal-1'],
          recentTabIds: ['terminal-1']
        }
      ]
    },
    tabGroupLayouts: { [WORKTREE_ID]: { type: 'leaf', groupId: 'group-1' } },
    activeGroupIdByWorktree: { [WORKTREE_ID]: 'group-1' },
    defaultTerminalTabsAppliedByWorktreeId: { [WORKTREE_ID]: true },
    ...overrides
  }
}

describe('closeTerminalTabInWorkspaceSession', () => {
  it('atomically removes a dormant split tab and returns every exact PTY', () => {
    const result = closeTerminalTabInWorkspaceSession(
      session({
        remoteSessionIdsByTabId: { 'terminal-1': 'pty-remote' },
        sleepingAgentSessionsByPaneKey: {
          'terminal-1:leaf-left': {
            paneKey: 'terminal-1:leaf-left',
            tabId: 'terminal-1',
            worktreeId: WORKTREE_ID,
            agent: 'codex',
            providerSession: { key: 'session_id', id: 'session-1' },
            prompt: 'continue',
            state: 'working',
            capturedAt: 1,
            updatedAt: 1
          }
        }
      }),
      WORKTREE_ID,
      'terminal-1'
    )

    expect(result).toMatchObject({ closed: true, pinned: false })
    expect(result.ptyIdsToKill.sort()).toEqual(['pty-left', 'pty-remote', 'pty-right'])
    expect(result.session.tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(result.session.terminalLayoutsByTabId['terminal-1']).toBeUndefined()
    expect(result.session.remoteSessionIdsByTabId?.['terminal-1']).toBeUndefined()
    expect(result.session.sleepingAgentSessionsByPaneKey).toEqual({})
    expect(result.session.defaultTerminalTabsAppliedByWorktreeId?.[WORKTREE_ID]).toBe(true)
  })

  it('does not kill a PTY still owned by another terminal tab', () => {
    const current = session({
      tabsByWorktree: {
        [WORKTREE_ID]: [
          terminalTab('terminal-1', 'shared-pty'),
          terminalTab('terminal-2', 'shared-pty')
        ]
      },
      terminalLayoutsByTabId: {
        'terminal-1': {
          root: { type: 'leaf', leafId: 'leaf-1' },
          activeLeafId: 'leaf-1',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-1': 'shared-pty' }
        },
        'terminal-2': {
          root: { type: 'leaf', leafId: 'leaf-2' },
          activeLeafId: 'leaf-2',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-2': 'shared-pty' }
        }
      }
    })

    const result = closeTerminalTabInWorkspaceSession(current, WORKTREE_ID, 'terminal-1')

    expect(result.ptyIdsToKill).toEqual([])
    expect(result.session.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual(['terminal-2'])
  })

  it('lands on the active browser survivor instead of an empty terminal group', () => {
    const current = session({
      browserTabsByWorktree: {
        [WORKTREE_ID]: [
          {
            id: 'browser-1',
            worktreeId: WORKTREE_ID,
            url: 'https://example.com',
            title: 'Docs',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      activeBrowserTabIdByWorktree: { [WORKTREE_ID]: 'browser-1' },
      unifiedTabs: {
        [WORKTREE_ID]: [
          unifiedTab('terminal-1', 'terminal-1', 'terminal'),
          unifiedTab('browser-1', 'browser-1', 'browser')
        ]
      },
      tabGroups: {
        [WORKTREE_ID]: [
          {
            id: 'group-1',
            worktreeId: WORKTREE_ID,
            activeTabId: 'terminal-1',
            tabOrder: ['terminal-1', 'browser-1'],
            recentTabIds: ['browser-1', 'terminal-1']
          }
        ]
      }
    })

    const result = closeTerminalTabInWorkspaceSession(current, WORKTREE_ID, 'terminal-1')

    expect(result.session.tabGroups?.[WORKTREE_ID]?.[0]?.activeTabId).toBe('browser-1')
    expect(result.session.activeTabTypeByWorktree?.[WORKTREE_ID]).toBe('browser')
    expect(result.session.activeBrowserTabIdByWorktree?.[WORKTREE_ID]).toBe('browser-1')
    expect(result.session.activeWorktreeId).toBe(WORKTREE_ID)
  })

  it('rejects pinned tabs without mutating the session', () => {
    const current = session({
      tabsByWorktree: { [WORKTREE_ID]: [terminalTab('terminal-1', 'pty-left', true)] }
    })

    const result = closeTerminalTabInWorkspaceSession(current, WORKTREE_ID, 'terminal-1')

    expect(result).toEqual({ session: current, ptyIdsToKill: [], closed: false, pinned: true })
  })

  it('has no bounded replay window after more than 32 closes', () => {
    let current = getDefaultWorkspaceSession()
    for (let index = 0; index < 40; index += 1) {
      const id = `terminal-${index}`
      current = {
        ...current,
        tabsByWorktree: {
          ...current.tabsByWorktree,
          [WORKTREE_ID]: [terminalTab(id, `pty-${index}`)]
        },
        terminalLayoutsByTabId: {
          ...current.terminalLayoutsByTabId,
          [id]: {
            root: { type: 'leaf', leafId: `leaf-${index}` },
            activeLeafId: `leaf-${index}`,
            expandedLeafId: null,
            ptyIdsByLeafId: { [`leaf-${index}`]: `pty-${index}` }
          }
        }
      }
      current = closeTerminalTabInWorkspaceSession(current, WORKTREE_ID, id).session
    }

    expect(current.tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(current.terminalLayoutsByTabId).toEqual({})
  })
})
