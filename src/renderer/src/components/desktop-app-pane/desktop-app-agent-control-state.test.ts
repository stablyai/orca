import { describe, expect, it, vi } from 'vitest'
import type { DesktopAppAgentActivity } from '../../../../shared/desktop-app-types'
import {
  AGENT_ACTION_MAX_MS,
  AGENT_CONTROL_IDLE_MS,
  INITIAL_AGENT_CONTROL_STATE,
  reduceAgentControl,
  requestAgentAllow,
  requestAgentStop,
  type DesktopAppAgentControlEvent
} from './desktop-app-agent-control-state'

function activity(overrides: Partial<DesktopAppAgentActivity>): DesktopAppAgentActivity {
  return {
    phase: 'start',
    activityId: 'a1',
    method: 'computer.click',
    appSelector: null,
    pid: null,
    windowId: null,
    point: null,
    ok: null,
    at: 1_000,
    ...overrides
  }
}

describe('agent control state', () => {
  it('shows control and the cursor while the agent acts, then hides after the idle gap', () => {
    let state = reduceAgentControl(INITIAL_AGENT_CONTROL_STATE, {
      type: 'activity',
      targetsPane: true,
      activity: activity({ point: { x: 10, y: 20 } })
    })
    expect(state).toMatchObject({
      controlling: true,
      cursor: { x: 10, y: 20 },
      inFlight: { a1: 1_000 }
    })
    state = reduceAgentControl(state, {
      type: 'activity',
      targetsPane: true,
      activity: activity({ phase: 'end', at: 2_000 })
    })
    expect(state.inFlight).toEqual({})
    expect(reduceAgentControl(state, { type: 'idle', now: 2_500 }).controlling).toBe(true)
    expect(
      reduceAgentControl(state, { type: 'idle', now: 2_000 + AGENT_CONTROL_IDLE_MS })
    ).toMatchObject({ controlling: false, cursor: null })
  })

  it('ignores activity after the user stops the agent until they allow it again', () => {
    const stopped = reduceAgentControl(INITIAL_AGENT_CONTROL_STATE, { type: 'stop' })
    expect(
      reduceAgentControl(stopped, { type: 'activity', targetsPane: true, activity: activity({}) })
        .controlling
    ).toBe(false)
    const allowed = reduceAgentControl(stopped, { type: 'allow' })
    expect(
      reduceAgentControl(allowed, { type: 'activity', targetsPane: true, activity: activity({}) })
        .controlling
    ).toBe(true)
  })

  it('shows the stopped state again when main still blocks the app after a remount', () => {
    const hydrated = reduceAgentControl(INITIAL_AGENT_CONTROL_STATE, { type: 'hydrateStopped' })
    expect(hydrated.stopped).toBe(true)
    expect(
      reduceAgentControl(hydrated, { type: 'activity', targetsPane: true, activity: activity({}) })
        .controlling
    ).toBe(false)
  })

  it('closes an action whose end resolved to a target the start did not name', () => {
    let state = reduceAgentControl(INITIAL_AGENT_CONTROL_STATE, {
      type: 'activity',
      targetsPane: true,
      activity: activity({ appSelector: 'Notes', point: { x: 5, y: 5 } })
    })
    state = reduceAgentControl(state, {
      type: 'activity',
      targetsPane: false,
      activity: activity({
        phase: 'end',
        pid: 1,
        windowId: 9,
        point: { x: 900, y: 900 },
        at: 2_000
      })
    })
    expect(state.inFlight).toEqual({})
    expect(state.cursor).toEqual({ x: 5, y: 5 })
    expect(
      reduceAgentControl(state, { type: 'idle', now: 2_000 + AGENT_CONTROL_IDLE_MS }).controlling
    ).toBe(false)
  })

  it('ignores the end of an action that never started on this pane', () => {
    const state = reduceAgentControl(INITIAL_AGENT_CONTROL_STATE, {
      type: 'activity',
      targetsPane: false,
      activity: activity({ phase: 'end', activityId: 'other' })
    })
    expect(state).toBe(INITIAL_AGENT_CONTROL_STATE)
  })

  it('lets go of an action whose end never arrives after the safety cap', () => {
    const state = reduceAgentControl(INITIAL_AGENT_CONTROL_STATE, {
      type: 'activity',
      targetsPane: true,
      activity: activity({})
    })
    expect(
      reduceAgentControl(state, { type: 'idle', now: 1_000 + AGENT_CONTROL_IDLE_MS })
    ).toMatchObject({ controlling: true, inFlight: { a1: 1_000 } })
    expect(
      reduceAgentControl(state, { type: 'idle', now: 1_000 + AGENT_ACTION_MAX_MS })
    ).toMatchObject({ controlling: false, inFlight: {} })
  })

  it('takes Stop back when main could not block the agent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const events: DesktopAppAgentControlEvent[] = []
    await requestAgentStop(
      (event) => events.push(event),
      () => Promise.reject(new Error('ipc gone'))
    )
    expect(events.map((event) => event.type)).toEqual(['stop', 'stopFailed'])
    const state = events.reduce(reduceAgentControl, INITIAL_AGENT_CONTROL_STATE)
    expect(state.stopped).toBe(false)
  })

  it('keeps Stop once main blocked the agent', async () => {
    const events: DesktopAppAgentControlEvent[] = []
    await requestAgentStop(
      (event) => events.push(event),
      () => Promise.resolve()
    )
    expect(events.map((event) => event.type)).toEqual(['stop'])
  })

  it('shows Stop again when main could not lift the block', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const events: DesktopAppAgentControlEvent[] = []
    await requestAgentAllow(
      (event) => events.push(event),
      () => Promise.reject(new Error('ipc gone'))
    )
    expect(events.map((event) => event.type)).toEqual(['allow', 'hydrateStopped'])
    const stopped = { ...INITIAL_AGENT_CONTROL_STATE, stopped: true }
    expect(events.reduce(reduceAgentControl, stopped).stopped).toBe(true)
  })

  it('leaves a newer target alone when an older Stop or Allow fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const events: DesktopAppAgentControlEvent[] = []
    const fail = () => Promise.reject(new Error('ipc gone'))
    await requestAgentStop(
      (event) => events.push(event),
      fail,
      () => false
    )
    await requestAgentAllow(
      (event) => events.push(event),
      fail,
      () => false
    )
    expect(events.map((event) => event.type)).toEqual(['stop', 'allow'])
  })
})
