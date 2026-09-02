import { describe, expect, it } from 'vitest'
import type { DashboardCard, DashboardWorkspace } from '../../../../shared/dashboard-snapshot'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { buildControlRoomTerminalItems, controlRoomSessionKey } from './control-room-terminal-items'

function card(overrides: Partial<DashboardCard> = {}): DashboardCard {
  return {
    paneKey: 'tab-1:leaf-1',
    ptyId: 'pty-1',
    agentType: 'codex',
    bucket: 'working',
    dotState: 'working',
    task: 'Build it',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    repoName: 'Ronin',
    worktreeName: 'agent-ledger',
    startedAt: 1,
    finishedAt: null,
    stateChangedAt: 1,
    unseen: true,
    ...overrides
  }
}

function unifiedTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'unified-1',
    entityId: 'tab-1',
    groupId: 'group-1',
    worktreeId: 'worktree-1',
    contentType: 'terminal',
    label: 'Ledger',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function terminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: 'pty-1',
    worktreeId: 'worktree-1',
    title: 'Ledger',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function workspace(overrides: Partial<DashboardWorkspace> = {}): DashboardWorkspace {
  return {
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    repoName: 'Ronin',
    worktreeName: 'agent-ledger',
    hostKind: 'local',
    executionHostId: 'local',
    workspaceKind: 'worktree',
    ...overrides
  }
}

function build(
  cards: DashboardCard[],
  scope: 'active' | 'all' | 'pinned' = 'active',
  overrides: {
    unifiedTabsByWorktree?: Record<string, Tab[]>
    terminalTabsByWorktree?: Record<string, TerminalTab[]>
    ptyIdsByTabId?: Record<string, string[]>
  } = {}
) {
  return buildControlRoomTerminalItems({
    cards,
    workspaces: [workspace()],
    unifiedTabsByWorktree: overrides.unifiedTabsByWorktree ?? {
      'worktree-1': [unifiedTab()]
    },
    terminalTabsByWorktree: overrides.terminalTabsByWorktree ?? {
      'worktree-1': [terminalTab()]
    },
    ptyIdsByTabId: overrides.ptyIdsByTabId ?? { 'tab-1': ['pty-1'] },
    generatedTabTitlesEnabled: false,
    pinnedSessionKeys: new Set(['local:worktree-1:tab-1']),
    scope
  })
}

describe('control room terminal items', () => {
  it('groups top-level agents by terminal and folds subagents into a count', () => {
    const items = build([
      card({ subagents: [{ id: 'child-1', name: 'helper', dotState: 'working' }] }),
      card({ paneKey: 'tab-1:leaf-2', leafId: 'leaf-2', dotState: 'waiting' })
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      terminalTabId: 'tab-1',
      worktreeId: 'worktree-1',
      ownerLabel: 'Ronin / agent-ledger',
      agentState: 'waiting',
      agentCount: 2,
      subagentCount: 1,
      pinned: true
    })
  })

  it('does not promote explicit child agents into separate cards', () => {
    const items = build([
      card(),
      card({ paneKey: 'tab-1:child', parentPaneKey: 'tab-1:leaf-1', leafId: 'child' })
    ])
    expect(items).toHaveLength(1)
    expect(items[0].agentCount).toBe(1)
  })

  it('keeps live recognized agents in every applicable view and omits stopped sessions', () => {
    const done = card({ dotState: 'done', bucket: 'idle', unseen: false })
    expect(build([done], 'active')).toHaveLength(1)
    expect(build([done], 'all')).toHaveLength(1)
    expect(build([done], 'pinned')).toHaveLength(1)

    const stopped = terminalTab({ ptyId: null })
    expect(
      build([done], 'active', {
        terminalTabsByWorktree: { 'worktree-1': [stopped] },
        ptyIdsByTabId: {}
      })
    ).toEqual([])
    expect(
      build([done], 'all', {
        terminalTabsByWorktree: { 'worktree-1': [stopped] },
        ptyIdsByTabId: {}
      })
    ).toEqual([])
  })

  it('adds live ordinary terminals only in the All view', () => {
    expect(build([])).toEqual([])
    const items = build([], 'all')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      terminalTabId: 'tab-1',
      ownerLabel: 'Ronin / agent-ledger'
    })
    expect(items[0].agentState).toBeUndefined()
  })

  it('includes execution host identity in persisted pin keys', () => {
    expect(controlRoomSessionKey(card({ executionHostId: 'ssh:server' }))).toBe(
      'ssh:server:worktree-1:tab-1'
    )
  })
})
