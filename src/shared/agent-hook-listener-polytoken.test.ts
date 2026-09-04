import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeHookPayload } from './agent-hook-listener'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { PANE_KEY } from './agent-hook-listener-test-harness'

// Why: payload shapes are the ones Polytoken 0.8.2 writes to hook stdin, plus the
// `hook_event_name`/`session_id`/`model_name` keys the managed script splices in from env.
const PROMPT_ID = '01a06a55-8f08-7df1-a012-b8880eb34f0f'

function envelope(payload: Record<string, unknown>) {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt',
    env: 'production',
    version: '1',
    payload: {
      session_id: '0a78mj-stock',
      model_name: 'zai/glm-5.3-flash',
      hook_event_name: payload.event,
      ...payload
    }
  }
}

describe('shared agent-hook-listener (polytoken)', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  it('lands session_start as resume identity only, never a working row', () => {
    const result = normalizeHookPayload(
      state,
      'polytoken',
      envelope({ event: 'session_start', matcher_subject: 'session_start' }),
      'production'
    )
    expect(result?.providerSessionOnly).toBe(true)
    expect(result?.providerSession).toEqual({ key: 'session_id', id: '0a78mj-stock' })
    expect(result?.payload.state).toBe('done')
  })

  it('tracks a turn from prompt through tools to stop with the model attached', () => {
    const prompt = normalizeHookPayload(
      state,
      'polytoken',
      envelope({
        event: 'pre_user_prompt',
        matcher_subject: 'pre_user_prompt',
        prompt_id: PROMPT_ID,
        prompt: 'Read hello.txt'
      }),
      'production'
    )
    expect(prompt?.payload).toMatchObject({
      state: 'working',
      agentType: 'polytoken',
      prompt: 'Read hello.txt',
      model: 'zai/glm-5.3-flash'
    })

    const modelTurn = normalizeHookPayload(
      state,
      'polytoken',
      envelope({
        event: 'pre_model_turn',
        matcher_subject: 'pre_model_turn',
        prompt_id: PROMPT_ID
      }),
      'production'
    )
    expect(modelTurn?.payload).toMatchObject({ state: 'working', prompt: 'Read hello.txt' })

    const tool = normalizeHookPayload(
      state,
      'polytoken',
      envelope({
        event: 'pre_tool_use',
        matcher_subject: 'file_read',
        prompt_id: PROMPT_ID,
        tool_name: 'file_read',
        call_id: 'call_1',
        input: { path: 'hello.txt' }
      }),
      'production'
    )
    expect(tool?.payload).toMatchObject({ state: 'working', toolName: 'file_read' })
    expect(tool?.payload.toolInput).toContain('hello.txt')

    const stop = normalizeHookPayload(
      state,
      'polytoken',
      envelope({ event: 'stop', matcher_subject: 'stop', prompt_id: PROMPT_ID }),
      'production'
    )
    expect(stop?.payload).toMatchObject({ state: 'done', prompt: 'Read hello.txt' })
  })

  it('shows the attention state while the ask-user tool waits, and ignores post_model_turn', () => {
    const waiting = normalizeHookPayload(
      state,
      'polytoken',
      envelope({
        event: 'pre_tool_use',
        matcher_subject: 'ask_user_question',
        tool_name: 'ask_user_question',
        input: { question: 'Which branch?' }
      }),
      'production'
    )
    expect(waiting?.payload).toMatchObject({ state: 'waiting', toolName: 'ask_user_question' })

    for (const event of ['post_model_turn', 'notification', 'facet_switch', 'subagent_start']) {
      expect(
        normalizeHookPayload(
          state,
          'polytoken',
          envelope({ event, matcher_subject: event }),
          'production'
        )
      ).toBeNull()
    }
  })

  it('surfaces a failed tool as the last message and clears the active tool', () => {
    const failed = normalizeHookPayload(
      state,
      'polytoken',
      envelope({
        event: 'post_tool_use_failure',
        matcher_subject: 'shell_exec',
        tool_name: 'shell_exec',
        error: 'command not found: frobnicate'
      }),
      'production'
    )
    expect(failed?.payload).toMatchObject({
      state: 'working',
      lastAssistantMessage: 'command not found: frobnicate',
      lastAssistantMessageIsToolOutput: true
    })
  })
})
