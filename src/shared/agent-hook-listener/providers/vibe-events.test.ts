import { beforeEach, describe, expect, it } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeHookPayload } from '../../agent-hook-listener'
import { PANE_KEY } from '../../agent-hook-listener-test-harness'

describe('normalizeVibeEvent', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  it('maps pre_tool to working with tool fields', () => {
    const result = normalizeHookPayload(
      state,
      'mistral-vibe',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'pre_tool',
          session_id: 'session_abc',
          transcript_path: '/repo/.vibe/sessions/abc.jsonl',
          cwd: '/repo',
          tool_name: 'Bash',
          tool_call_id: 'call_1',
          tool_input: { command: 'ls -la' }
        }
      },
      'production'
    )
    expect(result?.payload).toMatchObject({
      agentType: 'mistral-vibe',
      state: 'working',
      toolName: 'Bash',
      toolInput: 'ls -la'
    })
  })

  it('maps post_tool to working and surfaces tool_output_text as last assistant message', () => {
    const result = normalizeHookPayload(
      state,
      'mistral-vibe',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'post_tool',
          session_id: 'session_abc',
          tool_name: 'Bash',
          tool_call_id: 'call_1',
          tool_input: { command: 'ls' },
          tool_status: 'success',
          tool_output: { stdout: 'file.txt' },
          tool_output_text: 'file.txt',
          tool_error: null,
          duration_ms: 12
        }
      },
      'production'
    )
    expect(result?.payload).toMatchObject({
      agentType: 'mistral-vibe',
      state: 'working',
      toolName: 'Bash',
      lastAssistantMessage: 'file.txt',
      lastAssistantMessageIsToolOutput: true
    })
  })

  it('surfaces tool_error on a failed post_tool over tool_output_text', () => {
    const result = normalizeHookPayload(
      state,
      'mistral-vibe',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'post_tool',
          session_id: 'session_abc',
          tool_name: 'Bash',
          tool_call_id: 'call_1',
          tool_input: { command: 'bad' },
          tool_status: 'failure',
          tool_output: null,
          tool_output_text: '',
          tool_error: 'command not found',
          duration_ms: 5
        }
      },
      'production'
    )
    expect(result?.payload).toMatchObject({
      state: 'working',
      lastAssistantMessage: 'command not found',
      lastAssistantMessageIsToolOutput: true
    })
  })

  it('maps post_agent to done (new-turn boundary)', () => {
    const result = normalizeHookPayload(
      state,
      'mistral-vibe',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'post_agent',
          session_id: 'session_abc',
          transcript_path: '/repo/.vibe/sessions/abc.jsonl',
          cwd: '/repo'
        }
      },
      'production'
    )
    expect(result?.payload).toMatchObject({
      agentType: 'mistral-vibe',
      state: 'done'
    })
  })

  it('returns null for an unknown hook_event_name', () => {
    const result = normalizeHookPayload(
      state,
      'mistral-vibe',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'something_else',
          session_id: 'session_abc'
        }
      },
      'production'
    )
    expect(result).toBeNull()
  })
})
