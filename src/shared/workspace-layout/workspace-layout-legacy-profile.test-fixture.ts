// Stored partitions older writers leave disagreeing with themselves, one Loader rule each, so a
// test can compare what the window shows for each before and after the Loader rewrites it.

import { LOCAL_EXECUTION_HOST_ID } from '../execution-host'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import {
  sleepingRecord,
  type WorkspaceLayoutProfile
} from './workspace-layout-profile.test-fixture'
import { addWorkspace, emptySession, GIT_KEY, leaf } from './workspace-layout-session.test-fixture'

function twoTabs(): WorkspaceSessionState {
  return addWorkspace(emptySession(), GIT_KEY, [
    {
      id: 'g1',
      tabs: [
        { id: 'tab-a', leaves: [[leaf(1), 'pty-a']] },
        { id: 'tab-b', leaves: [[leaf(2), 'pty-b']] }
      ]
    }
  ])
}

/** Drops a terminal's tab-bar entry, leaving its row and pane layout. */
function withoutTabBarEntry(session: WorkspaceSessionState, tabId: string): WorkspaceSessionState {
  session.unifiedTabs![GIT_KEY] = session.unifiedTabs![GIT_KEY]!.filter((tab) => tab.id !== tabId)
  const group = session.tabGroups![GIT_KEY]![0]!
  group.tabOrder = group.tabOrder.filter((id) => id !== tabId)
  return session
}

const local = (name: string, build: () => WorkspaceSessionState): WorkspaceLayoutProfile => ({
  name,
  hostId: LOCAL_EXECUTION_HOST_ID,
  build
})

export const LEGACY_WORKSPACE_LAYOUT_PROFILES: readonly WorkspaceLayoutProfile[] = [
  local('row without a tab-bar entry or a terminal', () => {
    const session = withoutTabBarEntry(twoTabs(), 'tab-b')
    session.tabsByWorktree[GIT_KEY]![1]!.ptyId = null
    session.terminalLayoutsByTabId['tab-b']!.ptyIdsByLeafId = {}
    return session
  }),
  local('row without a tab-bar entry or a terminal, selected', () => {
    const session = withoutTabBarEntry(twoTabs(), 'tab-b')
    session.tabsByWorktree[GIT_KEY]![1]!.ptyId = null
    session.terminalLayoutsByTabId['tab-b']!.ptyIdsByLeafId = {}
    session.activeTabId = 'tab-b'
    session.activeTabIdByWorktree = { [GIT_KEY]: 'tab-b' }
    return session
  }),
  local('row without a tab-bar entry, its terminal in a workspace slept at shutdown', () => {
    const session = withoutTabBarEntry(twoTabs(), 'tab-b')
    session.activeWorktreeIdsOnShutdown = []
    return session
  }),
  // Controls for the cases above: the window adopts a row it can reattach, as the Loader does.
  local('row without a tab-bar entry, still bound to a terminal', () =>
    withoutTabBarEntry(twoTabs(), 'tab-b')
  ),
  local('row without a tab-bar entry, its terminal only on a relay', () => {
    const session = withoutTabBarEntry(twoTabs(), 'tab-b')
    session.tabsByWorktree[GIT_KEY]![1]!.ptyId = null
    session.terminalLayoutsByTabId['tab-b']!.ptyIdsByLeafId = {}
    session.remoteSessionIdsByTabId = { 'tab-b': 'relay-b' }
    return session
  }),
  local('row without a tab-bar entry, with a sleeping agent', () => {
    const session = withoutTabBarEntry(twoTabs(), 'tab-b')
    session.tabsByWorktree[GIT_KEY]![1]!.ptyId = null
    session.terminalLayoutsByTabId['tab-b']!.ptyIdsByLeafId = {}
    session.sleepingAgentSessionsByPaneKey = {
      [`tab-b:${leaf(2)}`]: sleepingRecord(GIT_KEY, 'tab-b', leaf(2))
    }
    return session
  }),
  local('row bound only through its pane, without a tab-bar entry', () => {
    const session = withoutTabBarEntry(twoTabs(), 'tab-b')
    session.tabsByWorktree[GIT_KEY]![1]!.ptyId = null
    return session
  }),
  local('legacy row repeating a tab-bar tab’s terminal', () => {
    const session = twoTabs()
    session.tabsByWorktree[GIT_KEY]!.push({
      ...session.tabsByWorktree[GIT_KEY]![0]!,
      id: 'tab-legacy',
      title: 'Terminal 3',
      sortOrder: 2,
      createdAt: 1_700_000_009_000
    })
    session.terminalLayoutsByTabId['tab-legacy'] = {
      root: { type: 'leaf', leafId: leaf(3) },
      activeLeafId: leaf(3),
      expandedLeafId: null,
      ptyIdsByLeafId: { [leaf(3)]: 'pty-a' }
    }
    return session
  }),
  local('legacy row repeating a tab-bar tab’s terminal, selected', () => {
    const session = twoTabs()
    session.tabsByWorktree[GIT_KEY]!.push({
      ...session.tabsByWorktree[GIT_KEY]![0]!,
      id: 'tab-legacy',
      title: 'Terminal 3',
      sortOrder: 2,
      createdAt: 1_700_000_009_000
    })
    session.terminalLayoutsByTabId['tab-legacy'] = {
      root: { type: 'leaf', leafId: leaf(3) },
      activeLeafId: leaf(3),
      expandedLeafId: null,
      ptyIdsByLeafId: { [leaf(3)]: 'pty-a' }
    }
    session.activeTabId = 'tab-legacy'
    session.activeTabIdByWorktree = { [GIT_KEY]: 'tab-legacy' }
    return session
  }),
  local('legacy split row sharing one pane’s terminal with a tab-bar tab', () => {
    const session = twoTabs()
    session.tabsByWorktree[GIT_KEY]!.push({
      ...session.tabsByWorktree[GIT_KEY]![0]!,
      id: 'tab-legacy',
      title: 'Terminal 3',
      sortOrder: 2,
      createdAt: 1_700_000_009_000
    })
    session.terminalLayoutsByTabId['tab-legacy'] = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: leaf(3) },
        second: { type: 'leaf', leafId: leaf(4) }
      },
      activeLeafId: leaf(3),
      expandedLeafId: null,
      ptyIdsByLeafId: { [leaf(3)]: 'pty-a', [leaf(4)]: 'pty-c' }
    }
    return session
  }),
  local('row terminal differs from its focused pane’s', () => {
    const session = twoTabs()
    session.tabsByWorktree[GIT_KEY]![0]!.ptyId = 'pty-stale'
    return session
  }),
  local('row with no terminal while its pane has one', () => {
    const session = twoTabs()
    session.tabsByWorktree[GIT_KEY]![0]!.ptyId = null
    return session
  }),
  local('tab listed by two groups, its tab-bar entry naming the second', () => {
    const session = addWorkspace(emptySession(), GIT_KEY, [
      { id: 'g1', tabs: [{ id: 'tab-a', leaves: [[leaf(1), 'pty-a']] }] },
      { id: 'g2', tabs: [{ id: 'tab-b', leaves: [[leaf(2), 'pty-b']] }] }
    ])
    // g1 lists tab-b; its entry still says g2, and g2 lists it too.
    session.tabGroups![GIT_KEY]![0]!.tabOrder.push('tab-b')
    return session
  }),
  local('session from before the tab bar, with an open file', () => {
    const session = twoTabs()
    delete session.unifiedTabs
    delete session.tabGroups
    delete session.tabGroupLayouts
    delete session.activeGroupIdByWorktree
    session.openFilesByWorktree = {
      [GIT_KEY]: [
        {
          filePath: '/Users/dev/orca/src/app.ts',
          relativePath: 'src/app.ts',
          worktreeId: GIT_KEY,
          language: 'typescript'
        }
      ]
    }
    session.activeFileIdByWorktree = { [GIT_KEY]: '/Users/dev/orca/src/app.ts' }
    session.activeTabTypeByWorktree = { [GIT_KEY]: 'editor' }
    return session
  }),
  local('session from before the tab bar, a row with no terminal', () => {
    const session = twoTabs()
    delete session.unifiedTabs
    delete session.tabGroups
    delete session.tabGroupLayouts
    delete session.activeGroupIdByWorktree
    session.tabsByWorktree[GIT_KEY]![1]!.ptyId = null
    session.terminalLayoutsByTabId['tab-b']!.ptyIdsByLeafId = {}
    return session
  }),
  local('legacy surface tombstone on a pane still showing its terminal', () => {
    const session = twoTabs()
    session.terminalSurfaceTombstonesByPaneKey = {
      [`tab-b:${leaf(2)}`]: {
        worktreeId: GIT_KEY,
        parentTabId: 'tab-b',
        leafId: leaf(2),
        ptyId: 'pty-b',
        incarnationId: 'inc',
        retiredAt: 1
      }
    }
    return session
  }),
  local('tab-bar label differing from the row title', () => {
    const session = twoTabs()
    session.unifiedTabs![GIT_KEY]![0]!.label = 'vim'
    return session
  })
]
