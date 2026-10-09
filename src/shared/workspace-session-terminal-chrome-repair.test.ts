import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from './constants'
import type { Tab, TabGroup } from './tab-types'
import type { TerminalTab } from './terminal-tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import {
  dedupeGhostTerminalTabRows,
  mintMissingTerminalTabChrome,
  restoreDroppedTerminalTabChrome
} from './workspace-session-terminal-chrome-repair'

const WORKTREE = 'repo::/dest'
const SPAWN = 'repo::/spawn'

function terminalTab(id: string, worktreeId: string, ptyId: string): TerminalTab {
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

function group(id: string, worktreeId: string, tabOrder: string[]): TabGroup {
  return { id, worktreeId, activeTabId: tabOrder[0] ?? null, tabOrder, recentTabIds: [...tabOrder] }
}

function baseSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: WORKTREE,
    activeTabId: 'tab-1',
    tabsByWorktree: {
      [WORKTREE]: [terminalTab('tab-1', WORKTREE, `${WORKTREE}@@pty-1`)]
    },
    unifiedTabs: {
      [WORKTREE]: [unifiedTab('tab-1', WORKTREE, 'group-1')]
    },
    tabGroups: {
      [WORKTREE]: [group('group-1', WORKTREE, ['tab-1'])]
    }
  }
}

describe('restoreDroppedTerminalTabChrome', () => {
  it('restores the tab chrome a stale save dropped while the row stayed PTY-bound', () => {
    const previous = baseSession()
    const stale: WorkspaceSessionState = {
      ...previous,
      unifiedTabs: { [WORKTREE]: [] },
      tabGroups: { [WORKTREE]: [group('group-1', WORKTREE, [])] }
    }

    const next = restoreDroppedTerminalTabChrome(stale, previous)

    expect(next.unifiedTabs?.[WORKTREE]?.map((tab) => tab.id)).toEqual(['tab-1'])
    expect(next.unifiedTabs?.[WORKTREE]?.[0]).toMatchObject({ groupId: 'group-1' })
    expect(next.tabGroups?.[WORKTREE]?.[0]?.tabOrder).toEqual(['tab-1'])
  })

  it('never invents chrome a row never had', () => {
    const previous: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: WORKTREE,
      tabsByWorktree: { [WORKTREE]: [terminalTab('tab-1', WORKTREE, `${WORKTREE}@@pty-1`)] }
    }

    const next = restoreDroppedTerminalTabChrome(previous, previous)

    expect(next.unifiedTabs?.[WORKTREE] ?? []).toHaveLength(0)
  })

  it('keeps a closed row closed', () => {
    const previous = baseSession()
    const closed: WorkspaceSessionState = {
      ...previous,
      tabsByWorktree: { [WORKTREE]: [] },
      unifiedTabs: { [WORKTREE]: [] },
      tabGroups: { [WORKTREE]: [group('group-1', WORKTREE, [])] }
    }

    const next = restoreDroppedTerminalTabChrome(closed, previous)

    expect(next.unifiedTabs?.[WORKTREE] ?? []).toHaveLength(0)
    expect(next.tabsByWorktree[WORKTREE]).toHaveLength(0)
  })

  it('judges ownership in the row own worktree', () => {
    const previous = baseSession()
    // The row lives in WORKTREE but a stale save pushed its chrome under SPAWN.
    const stale: WorkspaceSessionState = {
      ...previous,
      unifiedTabs: {
        [SPAWN]: [unifiedTab('tab-1', SPAWN, 'group-ghost')],
        [WORKTREE]: []
      },
      tabGroups: {
        [SPAWN]: [group('group-ghost', SPAWN, ['tab-1'])],
        [WORKTREE]: [group('group-1', WORKTREE, [])]
      }
    }

    const next = restoreDroppedTerminalTabChrome(stale, previous)

    expect(next.unifiedTabs?.[WORKTREE]?.map((tab) => tab.id)).toEqual(['tab-1'])
    expect(next.tabGroups?.[WORKTREE]?.[0]?.tabOrder).toEqual(['tab-1'])
  })
})

describe('dedupeGhostTerminalTabRows', () => {
  it('keeps the visible copy and drops the spawn-worktree ghost', () => {
    const previous = baseSession()
    const ghosted: WorkspaceSessionState = {
      ...previous,
      activeTabIdByWorktree: { [WORKTREE]: 'tab-1' },
      tabsByWorktree: {
        [WORKTREE]: [terminalTab('tab-1', WORKTREE, `${WORKTREE}@@pty-1`)],
        [SPAWN]: [terminalTab('tab-1', SPAWN, `${WORKTREE}@@pty-1`), terminalTab('tab-2', SPAWN, 'pty-2')]
      },
      unifiedTabs: {
        [WORKTREE]: [unifiedTab('tab-1', WORKTREE, 'group-1')],
        [SPAWN]: [unifiedTab('tab-1', SPAWN, 'group-ghost'), unifiedTab('tab-2', SPAWN, 'group-ghost')]
      },
      tabGroups: {
        [WORKTREE]: [group('group-1', WORKTREE, ['tab-1'])],
        [SPAWN]: [group('group-ghost', SPAWN, ['tab-1', 'tab-2'])]
      }
    }

    const next = dedupeGhostTerminalTabRows(ghosted, previous)

    expect(next.tabsByWorktree[SPAWN]?.map((tab) => tab.id)).toEqual(['tab-2'])
    expect(next.tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual(['tab-1'])
    expect(next.unifiedTabs?.[SPAWN]?.map((tab) => tab.id)).toEqual(['tab-2'])
    expect(next.tabGroups?.[SPAWN]?.[0]?.tabOrder).toEqual(['tab-2'])
  })

  it('prefers the previous save owner when no copy is visible', () => {
    const previous: WorkspaceSessionState = {
      ...previousSession(),
      tabsByWorktree: { [SPAWN]: [terminalTab('tab-1', SPAWN, `${WORKTREE}@@pty-1`)] }
    }
    const duplicate: WorkspaceSessionState = {
      ...previous,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {
        [WORKTREE]: [terminalTab('tab-1', WORKTREE, `${WORKTREE}@@pty-1`)],
        [SPAWN]: [terminalTab('tab-1', SPAWN, `${WORKTREE}@@pty-1`)]
      }
    }

    const next = dedupeGhostTerminalTabRows(duplicate, previous)

    expect(next.tabsByWorktree[SPAWN]?.map((tab) => tab.id)).toEqual(['tab-1'])
    expect(next.tabsByWorktree[WORKTREE] ?? []).toHaveLength(0)
  })

  it('prefers the copy outside its spawn worktree without history', () => {
    const duplicate: WorkspaceSessionState = {
      ...previousSession(),
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {
        [WORKTREE]: [terminalTab('tab-1', WORKTREE, `${SPAWN}@@pty-1`)],
        [SPAWN]: [terminalTab('tab-1', SPAWN, `${SPAWN}@@pty-1`)]
      }
    }

    const next = dedupeGhostTerminalTabRows(duplicate, undefined)

    expect(next.tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual(['tab-1'])
    expect(next.tabsByWorktree[SPAWN] ?? []).toHaveLength(0)
  })
})

describe('mintMissingTerminalTabChrome', () => {
  it('mints minimal chrome for a PTY-bound row that lost every trace of its tab', () => {
    const damaged: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: WORKTREE,
      activeTabId: 'tab-1',
      tabsByWorktree: {
        [WORKTREE]: [terminalTab('tab-1', WORKTREE, `${WORKTREE}@@pty-1`), terminalTab('tab-2', WORKTREE, '')]
      }
    }

    const next = mintMissingTerminalTabChrome(damaged)

    expect(next.unifiedTabs?.[WORKTREE]?.map((tab) => tab.entityId)).toEqual(['tab-1'])
    expect(next.tabGroups?.[WORKTREE]?.[0]?.tabOrder).toEqual(['tab-1'])
  })
})

function previousSession(): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), tabsByWorktree: {} }
}
