import { describe, expect, it } from 'vitest'
import type { DashboardCard, DashboardSnapshot } from '../../../shared/dashboard-snapshot'
import {
  MAX_DOCK_AGENT_ENTRIES,
  MAX_DOCK_AGENT_LABEL_LENGTH
} from '../../../shared/dock-agent-menu'
import { buildDockAgentMenuPayload } from './useDockAgentMenu'

function card(overrides: Partial<DashboardCard> = {}): DashboardCard {
  return {
    paneKey: 'tab-1:leaf-1',
    ptyId: 'pty-1',
    agentType: 'codex',
    bucket: 'working',
    dotState: 'working',
    task: 'Fix the Dock menu',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    repoName: 'Orca',
    worktreeName: 'feature/dock',
    startedAt: 100,
    finishedAt: null,
    stateChangedAt: 100,
    unseen: false,
    ...overrides
  }
}

function snapshot(cards: DashboardCard[]): DashboardSnapshot {
  return { generatedAt: 100, cards }
}

describe('buildDockAgentMenuPayload', () => {
  it('includes real working, blocked, and waiting agents while excluding title-derived rows', () => {
    const result = buildDockAgentMenuPayload(
      snapshot([
        card({ paneKey: 'working', dotState: 'working', startedAt: 100 }),
        card({ paneKey: 'blocked', dotState: 'blocked', startedAt: 200 }),
        card({ paneKey: 'waiting', dotState: 'waiting', startedAt: 300 }),
        card({ paneKey: 'done', dotState: 'done', startedAt: 400 }),
        card({ paneKey: 'title-derived', dotState: 'working', startedAt: 0 })
      ])
    )

    expect(result.active.map((entry) => entry.target.tabId)).toHaveLength(3)
    expect(result.active.map((entry) => entry.id)).toEqual([
      'local:repo-1:worktree-1:working',
      'local:repo-1:worktree-1:blocked',
      'local:repo-1:worktree-1:waiting'
    ])
  })

  it('includes unseen cards and terminal tabs with unread output', () => {
    const result = buildDockAgentMenuPayload(
      snapshot([
        card({ paneKey: 'unseen', unseen: true, tabId: 'tab-unseen' }),
        card({ paneKey: 'terminal', tabId: 'tab-terminal', unseen: false }),
        card({ paneKey: 'quiet', tabId: 'tab-quiet', unseen: false })
      ]),
      { 'tab-terminal': 'terminal-bell' }
    )

    expect(result.unread.map((entry) => entry.target.tabId)).toEqual(['tab-unseen', 'tab-terminal'])
  })

  it('makes duplicate labels readable and caps each group at the native menu limit', () => {
    const longTask = 'x'.repeat(MAX_DOCK_AGENT_LABEL_LENGTH + 40)
    const cards = Array.from({ length: MAX_DOCK_AGENT_ENTRIES + 1 }, (_, index) =>
      card({
        paneKey: `pane-${index}`,
        task: index < 2 ? 'Same task' : longTask,
        unseen: true
      })
    )
    const result = buildDockAgentMenuPayload(snapshot(cards))

    expect(result.unread).toHaveLength(MAX_DOCK_AGENT_ENTRIES)
    expect(result.unread[0]?.label).toBe('Orca / feature/dock · Same task')
    expect(result.unread[1]?.label).toBe('Orca / feature/dock · Same task (2)')
    expect(
      result.unread.every((entry) => Array.from(entry.label).length <= MAX_DOCK_AGENT_LABEL_LENGTH)
    ).toBe(true)
  })

  it('keeps the exact execution host and pane target for click-to-switch', () => {
    const result = buildDockAgentMenuPayload(
      snapshot([
        card({
          executionHostId: 'ssh:builder',
          repoId: 'remote-repo',
          worktreeId: 'remote-worktree',
          tabId: 'remote-tab',
          leafId: null
        })
      ])
    )

    expect(result.active[0]).toMatchObject({
      target: {
        repoId: 'remote-repo',
        worktreeId: 'remote-worktree',
        executionHostId: 'ssh:builder',
        tabId: 'remote-tab',
        leafId: null
      }
    })
  })
})
