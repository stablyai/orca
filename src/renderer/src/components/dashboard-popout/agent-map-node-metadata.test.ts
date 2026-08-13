import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import {
  AGENT_MAP_FINISH_FLARE_MS,
  AGENT_MAP_MAX_CONCURRENT_FINISH_FLARES,
  agentMapNodeStatus,
  agentMapQuietCount,
  emptyAgentMapStatusCounts,
  isAgentMapRecentFinish,
  selectAgentMapRecentFinishPaneKeys
} from './agent-map-node-metadata'

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

describe('agentMapNodeStatus', () => {
  it('splits a finish by whether it has been acknowledged', () => {
    expect(agentMapNodeStatus(card({ unseen: true }))).toBe('done')
    expect(agentMapNodeStatus(card({ unseen: false }))).toBe('done-seen')
  })

  it('never collapses an acknowledged finish into idle', () => {
    // The shared `dashboardCardDisplayState` does exactly that for bucket counts, which
    // would make finished-but-unlanded work indistinguishable from a workspace that
    // never ran. The map keeps them apart.
    expect(agentMapNodeStatus(card({ unseen: false }))).not.toBe('idle')
    expect(agentMapNodeStatus(card({ bucket: 'idle', dotState: 'idle', finishedAt: null }))).toBe(
      'idle'
    )
  })

  it('leaves every non-done state on the shared display state', () => {
    for (const dotState of ['working', 'blocked', 'waiting', 'idle'] as const) {
      expect(agentMapNodeStatus(card({ dotState, unseen: true }))).toBe(dotState)
      expect(agentMapNodeStatus(card({ dotState, unseen: false }))).toBe(dotState)
    }
  })
})

describe('isAgentMapRecentFinish', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('flares on the transition into done, measured against the wall clock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const justFinished = card({ dotState: 'done', unseen: true, stateChangedAt: NOW })

    expect(isAgentMapRecentFinish(justFinished)).toBe(true)
    vi.setSystemTime(NOW + AGENT_MAP_FINISH_FLARE_MS - 1)
    expect(isAgentMapRecentFinish(justFinished)).toBe(true)
    vi.setSystemTime(NOW + AGENT_MAP_FINISH_FLARE_MS + 1)
    expect(isAgentMapRecentFinish(justFinished)).toBe(false)
  })

  it('samples the wall clock once and caps bursty fleet updates', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const selected = selectAgentMapRecentFinishPaneKeys(
      Array.from({ length: 200 }, (_, index) =>
        card({ paneKey: `pane-${index}`, unseen: true, stateChangedAt: NOW - index })
      )
    )

    expect(clock).toHaveBeenCalledOnce()
    expect(selected.size).toBe(AGENT_MAP_MAX_CONCURRENT_FINISH_FLARES)
    expect([...selected]).toEqual(['pane-0', 'pane-1', 'pane-2', 'pane-3'])
  })

  it('does not flare work that finished before this session', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    expect(
      isAgentMapRecentFinish(card({ dotState: 'done', unseen: true, stateChangedAt: NOW - 60_000 }))
    ).toBe(false)
    // A clock skew that puts the finish in the future must not latch a flare on forever.
    expect(
      isAgentMapRecentFinish(card({ dotState: 'done', unseen: true, stateChangedAt: NOW + 5_000 }))
    ).toBe(false)
  })

  it('never flares a state that is not an unread finish', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    expect(
      isAgentMapRecentFinish(card({ dotState: 'done', unseen: false, stateChangedAt: NOW }))
    ).toBe(false)
    expect(
      isAgentMapRecentFinish(card({ dotState: 'working', unseen: true, stateChangedAt: NOW }))
    ).toBe(false)
  })
})

describe('agentMapQuietCount', () => {
  it('treats an acknowledged finish as quiet so label declutter is unchanged', () => {
    expect(agentMapQuietCount({ ...emptyAgentMapStatusCounts(), 'done-seen': 3, idle: 2 })).toBe(5)
  })

  it('keeps an unread finish loud', () => {
    expect(agentMapQuietCount({ ...emptyAgentMapStatusCounts(), done: 4 })).toBe(0)
    expect(agentMapQuietCount({ ...emptyAgentMapStatusCounts(), working: 4 })).toBe(0)
  })
})
