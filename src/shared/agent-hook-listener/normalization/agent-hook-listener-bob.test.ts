import { beforeEach, describe, expect, it } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeHookPayload } from './normalize-hook-payload'
import { PANE_KEY } from './agent-hook-listener-test-harness'

describe('shared agent-hook-listener', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  // Payload shapes below are verbatim captures from bobshell 2.0.2 (2026-09-12).
  it('normalizes Bob Shell Claude-compatible lifecycle events as bob status', () => {
    const started = normalizeHookPayload(
      state,
      'bob',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'SessionStart',
          session_id: '18959c65a0a57bf810ac78d14d1aa07a',
          cwd: '/repo',
          source: 'resume'
        }
      },
      'production'
    )
    const submitted = normalizeHookPayload(
      state,
      'bob',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'UserPromptSubmit',
          session_id: '18959c65a0a57bf810ac78d14d1aa07a',
          prompt: 'summarize the diff'
        }
      },
      'production'
    )
    const tool = normalizeHookPayload(
      state,
      'bob',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          session_id: '18959c65a0a57bf810ac78d14d1aa07a',
          tool_name: 'execute_command',
          tool_input: { command: 'echo HELLOFROMBOB' },
          tool_use_id: 'tooluse_GFMbfmSoADLqFXcH9e9wzV'
        }
      },
      'production'
    )
    const stopped = normalizeHookPayload(
      state,
      'bob',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'Stop',
          session_id: '18959c65a0a57bf810ac78d14d1aa07a',
          last_assistant_message: 'Done.'
        }
      },
      'production'
    )

    // Why: a resumed session emits SessionStart before any prompt; it must read as idle, not busy.
    expect(started?.payload).toMatchObject({
      agentType: 'bob',
      state: 'done',
      sessionBoundary: true
    })
    expect(submitted?.payload).toMatchObject({
      agentType: 'bob',
      state: 'working',
      prompt: 'summarize the diff'
    })
    expect(tool?.payload).toMatchObject({
      agentType: 'bob',
      state: 'working',
      toolName: 'execute_command'
    })
    expect(stopped?.payload).toMatchObject({ agentType: 'bob', state: 'done' })
    // Why: session_id is Bob's rootTaskId, which is exactly what `bob --resume` takes.
    expect(stopped?.providerSession).toMatchObject({
      key: 'session_id',
      id: '18959c65a0a57bf810ac78d14d1aa07a'
    })
  })
})
