import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
import { PANE_KEY } from './agent-hook-listener-test-harness'

describe('shared agent-hook-listener', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('maps jcode post_tool to working with the tool name', () => {
    const event = normalizeHookPayload(
      state,
      'jcode',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'post_tool',
          event: 'post_tool',
          session_id: 'session_jc_1',
          tool_name: 'read_file'
        }
      },
      'production'
    )
    expect(event?.payload).toMatchObject({
      agentType: 'jcode',
      state: 'working',
      toolName: 'read_file'
    })
  })

  it('maps jcode user-input tools to waiting', () => {
    const event = normalizeHookPayload(
      state,
      'jcode',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'post_tool',
          event: 'post_tool',
          session_id: 'session_jc_2',
          tool_name: 'ask_user'
        }
      },
      'production'
    )
    expect(event?.payload).toMatchObject({
      agentType: 'jcode',
      state: 'waiting',
      toolName: 'ask_user'
    })
  })

  it('maps jcode turn_end to done with the last assistant message', () => {
    const event = normalizeHookPayload(
      state,
      'jcode',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'turn_end',
          event: 'turn_end',
          session_id: 'session_jc_3',
          status: 'ok',
          last_assistant_message: 'Done.'
        }
      },
      'production'
    )
    expect(event?.payload).toMatchObject({
      agentType: 'jcode',
      state: 'done',
      lastAssistantMessage: 'Done.'
    })
  })

  it('treats jcode session_start as identity-only (no status row)', () => {
    const event = normalizeHookPayload(
      state,
      'jcode',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'session_start',
          event: 'session_start',
          session_id: 'session_jc_4',
          source: 'create'
        }
      },
      'production'
    )
    expect(event?.payload).toMatchObject({ agentType: 'jcode', state: 'done' })
    expect(event?.providerSession).toEqual({ key: 'session_id', id: 'session_jc_4' })
  })

  it('does not count a direct jcode prompt without journal evidence as explicit', () => {
    // Why: regression — a post_tool/turn_end prompt without a usable session id
    // has no journal backing, so it must not set hasExplicitPrompt.
    const event = normalizeHookPayload(
      state,
      'jcode',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'post_tool',
          event: 'post_tool',
          tool_name: 'read_file',
          prompt: 'fix the bug'
        }
      },
      'production'
    )
    expect(event?.payload).toMatchObject({ agentType: 'jcode', state: 'working' })
    expect(event?.hasExplicitPrompt).toBeFalsy()
  })
})
