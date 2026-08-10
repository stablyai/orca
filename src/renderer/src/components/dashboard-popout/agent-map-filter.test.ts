import { describe, expect, it } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { agentMapState, countAgentMapCards, filterAgentMapCards } from './agent-map-filter'

const NOW = 2_000_000_000

function card(overrides: Partial<DashboardCard> = {}): DashboardCard {
  return {
    paneKey: 'pane-1',
    ptyId: 'pty-1',
    agentType: 'codex',
    bucket: 'done',
    dotState: 'done',
    task: '',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    repoName: 'Orca',
    worktreeName: 'Agent map',
    startedAt: NOW - 60_000,
    finishedAt: NOW - 30_000,
    stateChangedAt: NOW - 30_000,
    unseen: false,
    hostKind: 'local',
    ...overrides
  }
}

describe('agent map filtering', () => {
  it('keeps unseen completions done and settles acknowledged completions into idle', () => {
    expect(agentMapState(card({ unseen: true }))).toBe('done')
    expect(agentMapState(card({ unseen: false }))).toBe('idle')
    expect(agentMapState(card({ bucket: 'idle', dotState: 'idle' }))).toBe('idle')
  })

  it('applies state and host filters independently', () => {
    const hidden = card({ paneKey: 'hidden', repoId: 'hidden', hostKind: 'ssh', unseen: true })
    const visible = filterAgentMapCards({
      cards: [hidden],
      enabledStates: new Set(['done']),
      hostFilter: 'ssh'
    })

    expect(visible).toEqual([hidden])
    expect(
      filterAgentMapCards({
        cards: [hidden],
        enabledStates: new Set(['idle']),
        hostFilter: 'ssh'
      })
    ).toEqual([])
    expect(
      filterAgentMapCards({
        cards: [hidden],
        enabledStates: new Set(['done']),
        hostFilter: 'local'
      })
    ).toEqual([])
  })

  it('counts all four display states', () => {
    const cards = [
      card({ paneKey: 'done-new', unseen: true }),
      card({ paneKey: 'done-seen', unseen: false }),
      card({ paneKey: 'working', bucket: 'working', dotState: 'working', finishedAt: null }),
      card({ paneKey: 'waiting', bucket: 'attention', dotState: 'waiting', finishedAt: null })
    ]

    expect(countAgentMapCards(cards)).toEqual({
      attention: 1,
      working: 1,
      done: 1,
      idle: 1
    })
  })
})
