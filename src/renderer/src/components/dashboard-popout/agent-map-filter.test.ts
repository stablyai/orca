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
  it('files both unseen and acknowledged completions under done, never idle', () => {
    expect(agentMapState(card({ unseen: true }))).toBe('done')
    // Why not idle: an acknowledged finish still paints emerald, so hiding "idle"
    // must not blank it out. Only a card that never finished is idle.
    expect(agentMapState(card({ unseen: false }))).toBe('done')
    expect(agentMapState(card({ bucket: 'idle', dotState: 'idle' }))).toBe('idle')
  })

  it('applies state and host filters independently', () => {
    const hidden = card({ paneKey: 'hidden', repoId: 'hidden', hostKind: 'ssh', unseen: true })
    const visible = filterAgentMapCards({
      cards: [hidden],
      enabledStates: new Set(['done']),
      enabledHosts: new Set(['ssh'])
    })

    expect(visible).toEqual([hidden])
    expect(
      filterAgentMapCards({
        cards: [hidden],
        enabledStates: new Set(['idle']),
        enabledHosts: new Set(['ssh'])
      })
    ).toEqual([])
    expect(
      filterAgentMapCards({
        cards: [hidden],
        enabledStates: new Set(['done']),
        enabledHosts: new Set(['local'])
      })
    ).toEqual([])
  })

  it('keeps every selected host rather than one at a time', () => {
    const local = card({ paneKey: 'local' })
    const ssh = card({ paneKey: 'ssh', hostKind: 'ssh' })
    const wsl = card({ paneKey: 'wsl', hostKind: 'wsl' })

    expect(
      filterAgentMapCards({
        cards: [local, ssh, wsl],
        enabledStates: new Set(['done']),
        enabledHosts: new Set(['local', 'wsl'])
      })
    ).toEqual([local, wsl])
  })

  it('treats a missing hostKind as local', () => {
    const legacy = card({ paneKey: 'legacy', hostKind: undefined })

    expect(
      filterAgentMapCards({
        cards: [legacy],
        enabledStates: new Set(['done']),
        enabledHosts: new Set(['local'])
      })
    ).toEqual([legacy])
    expect(
      filterAgentMapCards({
        cards: [legacy],
        enabledStates: new Set(['done']),
        enabledHosts: new Set(['ssh'])
      })
    ).toEqual([])
  })

  it('counts all four display states', () => {
    const cards = [
      card({ paneKey: 'done-new', unseen: true }),
      card({ paneKey: 'done-seen', unseen: false }),
      card({ paneKey: 'working', bucket: 'working', dotState: 'working', finishedAt: null }),
      card({ paneKey: 'waiting', bucket: 'attention', dotState: 'waiting', finishedAt: null }),
      card({ paneKey: 'idle', bucket: 'idle', dotState: 'idle', finishedAt: null })
    ]

    expect(countAgentMapCards(cards)).toEqual({
      attention: 1,
      working: 1,
      done: 2,
      idle: 1
    })
  })
})
