import { describe, expect, it } from 'vitest'
import {
  DASHBOARD_MAX_CUSTOM_LANES,
  DASHBOARD_MAX_LANE_PLACEMENTS,
  applyDashboardLaneAction,
  resolveDashboardCardLaneId,
  type DashboardLaneSettings
} from './dashboard-lanes'

const waiting = { id: 'lane-w', label: 'Waiting' }
const review = { id: 'lane-r', label: 'Review' }
let nextId = 0
const options = {
  newLaneId: () => `lane-new-${++nextId}`,
  isLivePaneKey: () => true
}

describe('resolveDashboardCardLaneId', () => {
  it('returns the parked lane for a non-attention card', () => {
    expect(resolveDashboardCardLaneId([waiting], { 'tab:1': 'lane-w' }, 'tab:1', 'done')).toBe(
      'lane-w'
    )
  })

  it('lets Needs You win over a parked lane', () => {
    expect(
      resolveDashboardCardLaneId([waiting], { 'tab:1': 'lane-w' }, 'tab:1', 'attention')
    ).toBeUndefined()
  })

  it('ignores a placement whose lane was removed', () => {
    expect(
      resolveDashboardCardLaneId([review], { 'tab:1': 'lane-w' }, 'tab:1', 'idle')
    ).toBeUndefined()
  })
})

describe('applyDashboardLaneAction', () => {
  it('adds a lane with a normalized label', () => {
    const patch = applyDashboardLaneAction(
      {},
      { kind: 'add', label: '  Waiting   on  CI ' },
      options
    )
    expect(patch?.agentDashboardCustomLanes).toEqual([
      { id: expect.stringMatching(/^lane-new-/), label: 'Waiting on CI' }
    ])
  })

  it('refuses empty labels and lanes past the cap', () => {
    expect(applyDashboardLaneAction({}, { kind: 'add', label: '   ' }, options)).toBeNull()
    const full: DashboardLaneSettings = {
      agentDashboardCustomLanes: Array.from({ length: DASHBOARD_MAX_CUSTOM_LANES }, (_, i) => ({
        id: `l${i}`,
        label: `L${i}`
      }))
    }
    expect(applyDashboardLaneAction(full, { kind: 'add', label: 'One more' }, options)).toBeNull()
  })

  it('renames an existing lane only', () => {
    const current = { agentDashboardCustomLanes: [waiting] }
    expect(
      applyDashboardLaneAction(
        current,
        { kind: 'rename', laneId: 'lane-w', label: 'Parked' },
        options
      )?.agentDashboardCustomLanes
    ).toEqual([{ id: 'lane-w', label: 'Parked' }])
    expect(
      applyDashboardLaneAction(current, { kind: 'rename', laneId: 'nope', label: 'x' }, options)
    ).toBeNull()
  })

  it('removes a lane and returns its cards to their status column', () => {
    const patch = applyDashboardLaneAction(
      {
        agentDashboardCustomLanes: [waiting, review],
        agentDashboardLaneByPaneKey: { 'tab:1': 'lane-w', 'tab:2': 'lane-r' }
      },
      { kind: 'remove', laneId: 'lane-w' },
      options
    )
    expect(patch).toEqual({
      agentDashboardCustomLanes: [review],
      agentDashboardLaneByPaneKey: { 'tab:2': 'lane-r' }
    })
  })

  it('parks, moves and unparks a card', () => {
    const lanes = { agentDashboardCustomLanes: [waiting, review] }
    const parked = applyDashboardLaneAction(
      lanes,
      { kind: 'place', paneKey: 'tab:1', laneId: 'lane-w' },
      options
    )
    expect(parked?.agentDashboardLaneByPaneKey).toEqual({ 'tab:1': 'lane-w' })
    const moved = applyDashboardLaneAction(
      { ...lanes, ...parked },
      { kind: 'place', paneKey: 'tab:1', laneId: 'lane-r' },
      options
    )
    expect(moved?.agentDashboardLaneByPaneKey).toEqual({ 'tab:1': 'lane-r' })
    const unparked = applyDashboardLaneAction(
      { ...lanes, ...moved },
      { kind: 'place', paneKey: 'tab:1', laneId: null },
      options
    )
    expect(unparked?.agentDashboardLaneByPaneKey).toEqual({})
  })

  it('treats a repeat or unknown-lane placement as a no-op', () => {
    const current = {
      agentDashboardCustomLanes: [waiting],
      agentDashboardLaneByPaneKey: { 'tab:1': 'lane-w' }
    }
    expect(
      applyDashboardLaneAction(
        current,
        { kind: 'place', paneKey: 'tab:1', laneId: 'lane-w' },
        options
      )
    ).toBeNull()
    expect(
      applyDashboardLaneAction(
        current,
        { kind: 'place', paneKey: 'tab:2', laneId: 'gone' },
        options
      )
    ).toBeNull()
  })

  it('prunes placements for closed panes and caps the map, oldest first', () => {
    const placements = Object.fromEntries(
      Array.from({ length: DASHBOARD_MAX_LANE_PLACEMENTS }, (_, i) => [`tab-${i}:1`, 'lane-w'])
    )
    const patch = applyDashboardLaneAction(
      { agentDashboardCustomLanes: [waiting], agentDashboardLaneByPaneKey: placements },
      { kind: 'place', paneKey: 'tab-new:1', laneId: 'lane-w' },
      { ...options, isLivePaneKey: (paneKey) => paneKey !== 'tab-5:1' }
    )
    const keys = Object.keys(patch?.agentDashboardLaneByPaneKey ?? {})
    expect(keys).toHaveLength(DASHBOARD_MAX_LANE_PLACEMENTS)
    expect(keys).not.toContain('tab-5:1')
    expect(keys.at(-1)).toBe('tab-new:1')
  })
})
