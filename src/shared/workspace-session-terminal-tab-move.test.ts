import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from './constants'
import type { Tab } from './tab-types'
import type { TerminalTab } from './terminal-tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import {
  moveTerminalTabInWorkspaceSession,
  partitionMovedTerminalTabHostSessions
} from './workspace-session-terminal-tab-move'

const SOURCE = 'repo::/src'
const DEST = 'repo::/dest'

function terminalTab(id: string, worktreeId: string, ptyId = 'pty-1'): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function unifiedTab(id: string, worktreeId: string, groupId: string): Tab {
  return {
    id,
    entityId: id,
    groupId,
    worktreeId,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function session(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: SOURCE,
    activeTabId: 'tab-1',
    tabsByWorktree: {
      [SOURCE]: [terminalTab('tab-1', SOURCE), terminalTab('tab-keep', SOURCE, 'pty-keep')],
      [DEST]: [terminalTab('tab-dest', DEST, 'pty-dest')]
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-1': 'pty-1' }
      }
    },
    activeTabIdByWorktree: { [SOURCE]: 'tab-1', [DEST]: 'tab-dest' },
    unifiedTabs: {
      [SOURCE]: [
        unifiedTab('tab-1', SOURCE, 'group-src'),
        unifiedTab('tab-keep', SOURCE, 'group-src')
      ],
      [DEST]: [unifiedTab('tab-dest', DEST, 'group-dest')]
    },
    tabGroups: {
      [SOURCE]: [
        {
          id: 'group-src',
          worktreeId: SOURCE,
          activeTabId: 'tab-1',
          tabOrder: ['tab-1', 'tab-keep'],
          recentTabIds: ['tab-1']
        }
      ],
      [DEST]: [
        {
          id: 'group-dest',
          worktreeId: DEST,
          activeTabId: 'tab-dest',
          tabOrder: ['tab-dest'],
          recentTabIds: ['tab-dest']
        }
      ]
    },
    tabGroupLayouts: {
      [SOURCE]: { type: 'leaf', groupId: 'group-src' },
      [DEST]: { type: 'leaf', groupId: 'group-dest' }
    }
  }
}

describe('moveTerminalTabInWorkspaceSession', () => {
  it('reattaches the tab without dropping its PTY binding', () => {
    const result = moveTerminalTabInWorkspaceSession(session(), SOURCE, DEST, 'tab-1')

    expect(result.moved).toBe(true)
    expect(result.session.tabsByWorktree[SOURCE]?.map((tab) => tab.id)).toEqual(['tab-keep'])
    expect(result.session.tabsByWorktree[DEST]?.map((tab) => tab.id)).toEqual(['tab-dest', 'tab-1'])
    expect(result.session.tabsByWorktree[DEST]?.at(-1)).toMatchObject({
      id: 'tab-1',
      worktreeId: DEST,
      ptyId: 'pty-1'
    })
    expect(result.session.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId).toEqual({
      'leaf-1': 'pty-1'
    })
    expect(result.session.unifiedTabs?.[DEST]?.map((tab) => tab.id)).toEqual(['tab-dest', 'tab-1'])
    expect(result.session.tabGroups?.[DEST]?.[0]?.tabOrder).toEqual(['tab-dest', 'tab-1'])
  })

  it('fails closed when the destination is the source or the tab is missing', () => {
    expect(moveTerminalTabInWorkspaceSession(session(), SOURCE, SOURCE, 'tab-1').moved).toBe(false)
    expect(moveTerminalTabInWorkspaceSession(session(), SOURCE, DEST, 'missing').moved).toBe(false)
  })

  it('rejects a terminal row that has no matching unified tab', () => {
    const broken = session()
    broken.unifiedTabs = {
      [SOURCE]: [unifiedTab('tab-keep', SOURCE, 'group-src')],
      [DEST]: [unifiedTab('tab-dest', DEST, 'group-dest')]
    }

    expect(() => moveTerminalTabInWorkspaceSession(broken, SOURCE, DEST, 'tab-1')).toThrow(
      'terminal_tab_state_inconsistent'
    )
    expect(broken.tabsByWorktree[SOURCE]?.map((tab) => tab.id)).toEqual(['tab-1', 'tab-keep'])
    expect(broken.tabGroups?.[DEST]?.[0]?.tabOrder).toEqual(['tab-dest'])
  })

  it('keeps dest and source host sessions from inheriting each other worktree keys', () => {
    const sourceSession = session()
    const destSession: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: DEST,
      activeTabId: 'tab-dest',
      tabsByWorktree: {
        [DEST]: [terminalTab('tab-dest', DEST, 'pty-dest')]
      },
      unifiedTabs: {
        [DEST]: [unifiedTab('tab-dest', DEST, 'group-dest')]
      },
      tabGroups: {
        [DEST]: [
          {
            id: 'group-dest',
            worktreeId: DEST,
            activeTabId: 'tab-dest',
            tabOrder: ['tab-dest'],
            recentTabIds: ['tab-dest']
          }
        ]
      },
      tabGroupLayouts: {
        [DEST]: { type: 'leaf', groupId: 'group-dest' }
      },
      activeTabIdByWorktree: { [DEST]: 'tab-dest' }
    }

    const partitioned = partitionMovedTerminalTabHostSessions({
      sourceSession,
      destSession,
      sourceWorktreeId: SOURCE,
      destWorktreeId: DEST,
      tabId: 'tab-1',
      sameHost: false
    })

    expect(partitioned).not.toBeNull()
    expect(Object.keys(partitioned!.dest.tabsByWorktree)).toEqual([DEST])
    expect(Object.keys(partitioned!.dest.unifiedTabs ?? {})).toEqual([DEST])
    expect(Object.keys(partitioned!.dest.tabGroups ?? {})).toEqual([DEST])
    expect(Object.keys(partitioned!.dest.tabGroupLayouts ?? {})).toEqual([DEST])
    expect(partitioned!.dest.tabsByWorktree[DEST]?.map((tab) => tab.id)).toEqual([
      'tab-dest',
      'tab-1'
    ])
    expect(Object.keys(partitioned!.source.tabsByWorktree)).toEqual([SOURCE])
    expect(partitioned!.source.tabsByWorktree[SOURCE]?.map((tab) => tab.id)).toEqual(['tab-keep'])
  })
})
