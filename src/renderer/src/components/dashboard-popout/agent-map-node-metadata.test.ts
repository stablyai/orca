import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import {
  AGENT_MAP_MAX_CONCURRENT_STATUS_FLARES,
  AGENT_MAP_STATUS_FLARE_MS,
  agentMapRecentFlareStatus,
  agentMapNodeStatus,
  agentMapQuietCount,
  emptyAgentMapStatusCounts,
  selectAgentMapRecentFlareStatuses
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

describe('agentMapRecentFlareStatus', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('flares on the transition into done, measured against the wall clock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const justFinished = card({ dotState: 'done', unseen: true, stateChangedAt: NOW })

    expect(agentMapRecentFlareStatus(justFinished)).toBe('done')
    vi.setSystemTime(NOW + AGENT_MAP_STATUS_FLARE_MS - 1)
    expect(agentMapRecentFlareStatus(justFinished)).toBe('done')
    vi.setSystemTime(NOW + AGENT_MAP_STATUS_FLARE_MS + 1)
    expect(agentMapRecentFlareStatus(justFinished)).toBeNull()
  })

  it('flares on the transition into a question', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)

    expect(
      agentMapRecentFlareStatus(
        card({ bucket: 'attention', dotState: 'waiting', unseen: true, stateChangedAt: NOW })
      )
    ).toBe('waiting')
  })

  it('does not reuse an earlier finish timestamp for a question with unknown timing', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)

    expect(
      agentMapRecentFlareStatus(
        card({ dotState: 'waiting', stateChangedAt: 0, finishedAt: NOW, unseen: true })
      )
    ).toBeNull()
  })

  it('samples the wall clock once and caps mixed bursty fleet updates', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const selected = selectAgentMapRecentFlareStatuses(
      Array.from({ length: 200 }, (_, index) =>
        card({
          paneKey: `pane-${index}`,
          bucket: index % 2 === 0 ? 'done' : 'attention',
          dotState: index % 2 === 0 ? 'done' : 'waiting',
          unseen: true,
          stateChangedAt: NOW - index
        })
      )
    )

    expect(clock).toHaveBeenCalledOnce()
    expect(selected.size).toBe(AGENT_MAP_MAX_CONCURRENT_STATUS_FLARES)
    expect([...selected]).toEqual([
      ['pane-0', 'done'],
      ['pane-1', 'waiting'],
      ['pane-2', 'done'],
      ['pane-3', 'waiting']
    ])
  })

  it('does not flare status changes from before this session', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    expect(
      agentMapRecentFlareStatus(
        card({ dotState: 'done', unseen: true, stateChangedAt: NOW - 60_000 })
      )
    ).toBeNull()
    // A clock skew that puts the finish in the future must not latch a flare on forever.
    expect(
      agentMapRecentFlareStatus(
        card({ dotState: 'done', unseen: true, stateChangedAt: NOW + 5_000 })
      )
    ).toBeNull()
  })

  it('never flares a state that is not a question or unread finish', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    expect(
      agentMapRecentFlareStatus(card({ dotState: 'done', unseen: false, stateChangedAt: NOW }))
    ).toBeNull()
    expect(
      agentMapRecentFlareStatus(card({ dotState: 'working', unseen: true, stateChangedAt: NOW }))
    ).toBeNull()
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
