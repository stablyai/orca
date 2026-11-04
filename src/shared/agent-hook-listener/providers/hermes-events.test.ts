import { describe, expect, it } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeHermesEvent } from './hermes-events'

describe('normalizeHermesEvent', () => {
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
