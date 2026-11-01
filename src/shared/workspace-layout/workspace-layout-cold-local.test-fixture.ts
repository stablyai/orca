import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { recordClosedTerminalTabTombstone } from '../closed-terminal-tab-tombstones'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  FOLDER_KEY,
  leaf
} from './workspace-layout-session.test-fixture'
import { localDesktopSession } from './workspace-layout-profile.test-fixture'

export const populations = [
  'closed',
  'home-rows',
  'home-names',
  'legacy',
  'groups',
  'browser'
] as const
export type Population = (typeof populations)[number]

export function coldInput(kind: Population, n: number): WorkspaceSessionState {
  const saved = addWorkspace(emptySession(), GIT_KEY, [
    { id: 'g', tabs: [{ id: 'active', leaves: [[leaf(1), 'live']] }] }
  ])
  if (kind === 'closed') {
    for (let i = 0; i < n; i++) {
      saved.closedTerminalTabTombstonesByTabId = recordClosedTerminalTabTombstone(
        saved.closedTerminalTabTombstonesByTabId,
        `closed-${i}`,
        { worktreeId: GIT_KEY },
        1700000000000 + i
      )
    }
  } else if (kind === 'home-rows' || kind === 'home-names') {
    const row = saved.tabsByWorktree[GIT_KEY][0]
    saved.tabsByWorktree[GIT_KEY] = Array.from({ length: kind === 'home-rows' ? n : 20 }, () => ({
      ...row
    }))
    saved.tabsByWorktree[FOLDER_KEY] = [{ ...row, worktreeId: FOLDER_KEY }]
    const entry = saved.unifiedTabs![GIT_KEY][0]
    saved.unifiedTabs![GIT_KEY] = Array.from(
      { length: kind === 'home-names' ? n : 40 },
      (_, i) => ({ ...entry, id: `absent-${i}`, entityId: `absent-${i}` })
    )
    saved.unifiedTabs![FOLDER_KEY] = [{ ...entry, worktreeId: FOLDER_KEY }]
    saved.tabGroups = {}
  } else if (kind === 'legacy') {
    delete saved.terminalLayoutsByTabId.active
    const row = saved.tabsByWorktree[GIT_KEY][0]
    saved.tabsByWorktree[GIT_KEY] = Array.from({ length: 10 }, (_, i) => ({
      ...row,
      id: `legacy-${i}`,
      ptyId: null
    }))
    saved.unifiedTabs = {}
    saved.tabGroups = {}
    saved.terminalPtyIncarnationsByPaneKey = Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`unrelated-${i}:leaf`, `inc-${i}`])
    )
  } else if (kind === 'groups') {
    saved.tabGroups![GIT_KEY] = Array.from({ length: n }, (_, i) => ({
      id: `group-${i}`,
      worktreeId: GIT_KEY,
      activeTabId: null,
      tabOrder: []
    }))
    saved.unifiedTabs![GIT_KEY][0].groupId = `group-${n - 1}`
  } else {
    const template = localDesktopSession().browserTabsByWorktree![GIT_KEY][0]
    saved.browserTabsByWorktree = {
      [GIT_KEY]: Array.from({ length: n }, (_, i) => ({ ...template, id: `browser-${i}` }))
    }
  }
  return saved
}
