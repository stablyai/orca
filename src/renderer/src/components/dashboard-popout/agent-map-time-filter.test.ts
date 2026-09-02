import { describe, expect, it } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import {
  AGENT_MAP_TIME_MAX_INDEX,
  agentMapDurations,
  agentMapTimeStopLabel,
  fullAgentMapTimeRanges,
  matchesAgentMapTimeRanges
} from './agent-map-time-filter'

const NOW = 2_000_000_000_000
const MINUTE = 60_000
const HOUR = 60 * MINUTE

function card(overrides: Partial<DashboardCard> = {}): DashboardCard {
  return {
    paneKey: 'pane-1',
    ptyId: null,
    agentType: 'codex',
    bucket: 'working',
    dotState: 'working',
    task: '',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    repoName: 'Orca',
    worktreeName: 'Agent map',
    startedAt: NOW - 2 * HOUR,
    finishedAt: null,
    stateChangedAt: NOW - 30 * MINUTE,
    statusUpdatedAt: NOW - 10 * MINUTE,
    unseen: false,
    ...overrides
  }
}

describe('agent map time filtering', () => {
  it('measures a finished agent to its finish, not to now', () => {
    const finished = agentMapDurations(
      card({ finishedAt: NOW - HOUR, startedAt: NOW - 3 * HOUR }),
      NOW
    )
    const running = agentMapDurations(card({ startedAt: NOW - 3 * HOUR }), NOW)

    expect(finished.lifespan).toBe(2 * HOUR)
    expect(running.lifespan).toBe(3 * HOUR)
  })

  it('falls back to the state change when no hook update has landed', () => {
    const durations = agentMapDurations(
      card({ statusUpdatedAt: undefined, stateChangedAt: NOW - 45 * MINUTE }),
      NOW
    )

    expect(durations.sinceMessage).toBe(45 * MINUTE)
    expect(durations.timeInState).toBe(45 * MINUTE)
  })

  it('does not classify unknown timestamps as ancient', () => {
    expect(
      agentMapDurations(card({ startedAt: 0, stateChangedAt: 0, statusUpdatedAt: undefined }), NOW)
    ).toEqual({ lifespan: 0, sinceMessage: 0, timeInState: 0 })
  })

  it('keeps every card when the ranges are untouched', () => {
    expect(matchesAgentMapTimeRanges(card(), fullAgentMapTimeRanges(), NOW)).toBe(true)
  })

  it('treats the top stop as unbounded so nothing falls off the end', () => {
    const ancient = card({ startedAt: NOW - 400 * 24 * HOUR })
    const ranges = fullAgentMapTimeRanges()
    ranges.lifespan = { min: 9, max: AGENT_MAP_TIME_MAX_INDEX }

    expect(matchesAgentMapTimeRanges(ancient, ranges, NOW)).toBe(true)
  })

  it('excludes a card quieter than the window and keeps one inside it', () => {
    const ranges = fullAgentMapTimeRanges()
    // Stop 4 is 30m: "stuck" means working with nothing said for half an hour.
    ranges.sinceMessage = { min: 4, max: AGENT_MAP_TIME_MAX_INDEX }

    expect(
      matchesAgentMapTimeRanges(card({ statusUpdatedAt: NOW - 5 * MINUTE }), ranges, NOW)
    ).toBe(false)
    expect(matchesAgentMapTimeRanges(card({ statusUpdatedAt: NOW - HOUR }), ranges, NOW)).toBe(true)
  })

  it('labels stops in the unit a human would say them in', () => {
    expect(agentMapTimeStopLabel(0)).toBe('0')
    expect(agentMapTimeStopLabel(4)).toBe('30m')
    expect(agentMapTimeStopLabel(9)).toBe('1d')
    expect(agentMapTimeStopLabel(AGENT_MAP_TIME_MAX_INDEX)).toBe('∞')
  })
})
