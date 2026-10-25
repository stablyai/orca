import { describe, expect, it } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
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

  // Sequences captured from real Hermes sessions (session ids shortened).
  const event = (state: HookListenerState, name: string, payload: Record<string, unknown>) =>
    normalizeHermesEvent(state, name, '', 'pane-1', payload)

  it('ignores review-fork tool hooks after the turn ended until the next turn starts', () => {
    const state = createHookListenerState()
    const parent = { session_id: 'local-parent' }
    const memory = { ...parent, tool_name: 'memory' }
    event(state, 'pre_llm_call', parent)
    event(state, 'post_llm_call', parent)
    event(state, 'on_session_end', parent)
    expect(event(state, 'pre_tool_call', memory)).toBeNull()
    expect(event(state, 'post_tool_call', memory)).toBeNull()
    expect(event(state, 'pre_approval_request', { command: 'rm' })).toMatchObject({
      state: 'waiting'
    })

    event(state, 'pre_llm_call', parent)
    expect(event(state, 'pre_tool_call', { ...parent, tool_name: 'terminal' })).toMatchObject({
      state: 'working',
      toolName: 'terminal'
    })
  })

  it('treats a rotated-id turn after an interrupted one as the pane turn, not a child', () => {
    const state = createHookListenerState()
    event(state, 'pre_llm_call', { session_id: 'local-parent' })
    const rotated = { session_id: 'local-compressed' }
    event(state, 'pre_llm_call', rotated)
    event(state, 'post_llm_call', rotated)
    expect(event(state, 'pre_tool_call', { ...rotated, tool_name: 'memory' })).toBeNull()
  })

  it("keeps admitting the parent's tools after a delegate_task child's turn ends", () => {
    const state = createHookListenerState()
    const parent = { session_id: 'local-parent' }
    const child = { session_id: '20261024_child', platform: 'subagent' }
    event(state, 'pre_llm_call', parent)
    event(state, 'pre_tool_call', { ...parent, tool_name: 'delegate_task' })
    event(state, 'post_tool_call', { ...parent, tool_name: 'delegate_task' })
    event(state, 'on_session_start', child)
    event(state, 'pre_llm_call', child)
    event(state, 'post_llm_call', child)
    event(state, 'on_session_end', child)
    expect(event(state, 'pre_tool_call', { ...parent, tool_name: 'read_file' })).toMatchObject({
      state: 'working',
      toolName: 'read_file'
    })
  })
})
