import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  isAgentBusyForRoam,
  isRoamPaused,
  pickRoamTarget,
  ROAM_MIN_STROLL_PX,
  stepRoamPosition,
  tickRoam
} from './pet-roam'

const viewport = { width: 800, height: 600 }
const size = 180

function entry(state: AgentStatusEntry['state'], now = 10_000): AgentStatusEntry {
  return {
    paneKey: 'p1',
    state,
    stateStartedAt: now - 100,
    updatedAt: now - 50,
    prompt: '',
    stateHistory: []
  }
}

describe('isRoamPaused', () => {
  it('pauses while dragging or agent busy', () => {
    expect(isRoamPaused({ dragging: true, agentBusy: false })).toBe(true)
    expect(isRoamPaused({ dragging: false, agentBusy: true })).toBe(true)
    expect(isRoamPaused({ dragging: false, agentBusy: false })).toBe(false)
  })
})

describe('isAgentBusyForRoam', () => {
  const staleAfter = 60_000
  const now = 10_000

  it('treats working/blocked/waiting as busy', () => {
    expect(isAgentBusyForRoam([entry('working', now)], now, staleAfter)).toBe(true)
    expect(isAgentBusyForRoam([entry('blocked', now)], now, staleAfter)).toBe(true)
    expect(isAgentBusyForRoam([entry('waiting', now)], now, staleAfter)).toBe(true)
  })

  it('does not treat idle/done as busy', () => {
    expect(isAgentBusyForRoam([entry('done', now)], now, staleAfter)).toBe(false)
    expect(isAgentBusyForRoam([], now, staleAfter)).toBe(false)
  })
})

describe('pickRoamTarget', () => {
  it('keeps the pet square inside the viewport', () => {
    const from = { x: 100, y: 100 }
    // Deterministic: always aim high-right
    const target = pickRoamTarget(from, size, viewport, () => 0.99)
    expect(target.x).toBeGreaterThanOrEqual(0)
    expect(target.y).toBeGreaterThanOrEqual(0)
    expect(target.x).toBeLessThanOrEqual(viewport.width - size)
    expect(target.y).toBeLessThanOrEqual(viewport.height - size)
    expect(Math.hypot(target.x - from.x, target.y - from.y)).toBeGreaterThanOrEqual(
      ROAM_MIN_STROLL_PX
    )
  })

  it('returns a clamped position when the viewport is smaller than the pet', () => {
    const tiny = { width: 100, height: 100 }
    const target = pickRoamTarget({ x: 50, y: 50 }, size, tiny, () => 0.5)
    expect(target).toEqual({ x: 0, y: 0 })
  })
})

describe('stepRoamPosition', () => {
  it('advances toward the target over time and eventually arrives', () => {
    const from = { x: 0, y: 0 }
    const target = { x: 200, y: 0 }
    const mid = stepRoamPosition(from, target, size, viewport, 1000, 0.05)
    expect(mid.arrived).toBe(false)
    expect(mid.position.x).toBeGreaterThan(0)
    expect(mid.position.x).toBeLessThan(200)

    const end = stepRoamPosition(from, target, size, viewport, 10_000, 0.05)
    expect(end.arrived).toBe(true)
    expect(end.position).toEqual(target)
  })

  it('clamps stepped positions to the viewport', () => {
    const { position } = stepRoamPosition(
      { x: 0, y: 0 },
      { x: 9999, y: 9999 },
      size,
      viewport,
      50_000,
      1
    )
    expect(position.x).toBe(viewport.width - size)
    expect(position.y).toBe(viewport.height - size)
  })
})

describe('tickRoam', () => {
  it('freezes position and target while paused', () => {
    const position = { x: 10, y: 20 }
    const target = { x: 200, y: 20 }
    const out = tickRoam({
      position,
      target,
      size,
      viewport,
      dtMs: 500,
      paused: true
    })
    expect(out.position).toEqual(position)
    expect(out.target).toEqual(target)
  })

  it('picks a target and advances when idle', () => {
    let calls = 0
    const rng = (): number => {
      calls++
      return 0.9
    }
    const start = { x: 0, y: 0 }
    const first = tickRoam({
      position: start,
      target: null,
      size,
      viewport,
      dtMs: 500,
      paused: false,
      rng,
      speedPxPerMs: 0.1
    })
    expect(calls).toBeGreaterThan(0)
    expect(first.target).not.toBeNull()
    expect(first.position.x + first.position.y).toBeGreaterThan(0)

    // Keep stepping until arrived → target clears
    let state = first
    for (let i = 0; i < 200 && state.target; i++) {
      state = tickRoam({
        position: state.position,
        target: state.target,
        size,
        viewport,
        dtMs: 200,
        paused: false,
        rng,
        speedPxPerMs: 0.5
      })
    }
    expect(state.target).toBeNull()
  })
})
