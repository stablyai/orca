import { describe, expect, it } from 'vitest'
import { createHookListenerState } from '../listener-state'
import { normalizeHermesEvent } from './hermes-events'

const normalize = (eventName: string, payload: Record<string, unknown> = {}) =>
  normalizeHermesEvent(createHookListenerState(), eventName, '', 'pane-1', payload)

describe('normalizeHermesEvent', () => {
  // Hermes fires `on_session_start` when a session is opened, switched or reset — never for a
  // turn (`pre_llm_call` carries the user message). Mapping it to `working` parked a freshly
  // launched pane in a fresh `working` row for the whole 30-minute staleness window, so
  // `terminal wait --for tui-idle` timed out against an idle composer.
  it('lands session start as an idle session boundary, not a running turn', () => {
    expect(normalize('on_session_start', { session_id: 's1' })).toMatchObject({
      state: 'done',
      sessionBoundary: true
    })
  })

  it('flags only session start as a boundary, so a turn-end done cannot claim one', () => {
    for (const eventName of [
      'post_llm_call',
      'on_session_end',
      'on_session_finalize',
      'on_session_reset'
    ]) {
      const parsed = normalize(eventName, { session_id: 's1' })
      expect(parsed).toMatchObject({ state: 'done' })
      expect(parsed?.sessionBoundary).toBeUndefined()
    }
  })

  it('keeps the turn and approval states the plugin reports', () => {
    expect(normalize('pre_llm_call', { user_message: 'hi' })).toMatchObject({ state: 'working' })
    expect(normalize('pre_tool_call', { tool_name: 'terminal' })).toMatchObject({
      state: 'working'
    })
    expect(normalize('pre_approval_request', { command: 'rm' })).toMatchObject({
      state: 'waiting'
    })
  })

  it('ignores events Orca does not subscribe to', () => {
    expect(normalize('subagent_stop')).toBeNull()
    expect(normalize('post_api_request')).toBeNull()
  })

  // Regression: Hermes posts pre_tool_call/post_tool_call over an async channel with no
  // ordering guarantee against post_llm_call. A tool-call event delivered after the turn's
  // own done hook must not resurrect `working` and clobber the done the user already saw.
  it('drops a post_tool_call that arrives after the turn already ended', () => {
    const state = createHookListenerState()
    expect(normalizeHermesEvent(state, 'pre_llm_call', 'hi', 'pane-1', {})).toMatchObject({
      state: 'working'
    })
    expect(normalizeHermesEvent(state, 'post_llm_call', '', 'pane-1', {})).toMatchObject({
      state: 'done'
    })
    expect(
      normalizeHermesEvent(state, 'post_tool_call', '', 'pane-1', { tool_name: 'terminal' })
    ).toBeNull()
    expect(
      normalizeHermesEvent(state, 'pre_tool_call', '', 'pane-1', { tool_name: 'terminal' })
    ).toBeNull()
    expect(normalizeHermesEvent(state, 'post_approval_response', '', 'pane-1', {})).toBeNull()
  })

  it('admits tool-call events again once a new turn opens after a stale close', () => {
    const state = createHookListenerState()
    normalizeHermesEvent(state, 'pre_llm_call', 'hi', 'pane-1', {})
    normalizeHermesEvent(state, 'post_llm_call', '', 'pane-1', {})
    expect(normalizeHermesEvent(state, 'pre_llm_call', 'again', 'pane-1', {})).toMatchObject({
      state: 'working'
    })
    expect(
      normalizeHermesEvent(state, 'pre_tool_call', '', 'pane-1', { tool_name: 'terminal' })
    ).toMatchObject({ state: 'working' })
  })

  it("keeps separate panes from latching each other's turn state", () => {
    const state = createHookListenerState()
    normalizeHermesEvent(state, 'pre_llm_call', 'hi', 'pane-1', {})
    normalizeHermesEvent(state, 'post_llm_call', '', 'pane-1', {})
    expect(
      normalizeHermesEvent(state, 'pre_tool_call', '', 'pane-2', { tool_name: 'terminal' })
    ).toMatchObject({ state: 'working' })
  })
})
