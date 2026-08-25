import { beforeEach, describe, expect, it } from 'vitest'
import { createHookListenerState, type HookListenerState } from './agent-hook-listener'
import { normalizeAndAccept, PANE_KEY } from './agent-hook-listener-test-harness'

describe('shared agent-hook-listener: aug (Auggie)', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  it('maps SessionStart to a done/idle row and treats it as a new-turn boundary', () => {
    const event = normalizeAndAccept(state, 'aug', { hook_event_name: 'SessionStart' })
    expect(event?.payload.state).toBe('done')
    expect(event?.payload.agentType).toBe('aug')
    expect(event?.payload.sessionBoundary).toBe(true)
  })

  it('maps PromptSubmit to working and treats it as a new-turn boundary', () => {
    const event = normalizeAndAccept(state, 'aug', {
      hook_event_name: 'PromptSubmit',
      user_prompt: 'fix the bug'
    })
    expect(event?.payload.state).toBe('working')
    expect(event?.payload.prompt).toBe('fix the bug')
    expect(event?.payload.sessionBoundary).toBeUndefined()
  })

  it('resets the cached prompt on a second PromptSubmit within the same interactive session', () => {
    normalizeAndAccept(state, 'aug', { hook_event_name: 'PromptSubmit', user_prompt: 'first turn' })
    normalizeAndAccept(state, 'aug', {
      hook_event_name: 'Stop',
      agent_stop_cause: 'end_turn'
    })
    const event = normalizeAndAccept(state, 'aug', {
      hook_event_name: 'PromptSubmit',
      user_prompt: 'second turn'
    })
    expect(event?.payload.state).toBe('working')
    expect(event?.payload.prompt).toBe('second turn')
  })

  it('maps PreToolUse to working and captures tool name/input', () => {
    const event = normalizeAndAccept(state, 'aug', {
      hook_event_name: 'PreToolUse',
      tool_name: 'view',
      tool_input: { path: 'src/index.ts' }
    })
    expect(event?.payload.state).toBe('working')
    expect(event?.payload.toolName).toBe('view')
    expect(event?.payload.toolInput).toContain('src/index.ts')
  })

  it('maps PreToolUse for the ask-user tool to waiting', () => {
    // Why: 'ask-user' is Auggie's actual bundled tool name (verified against auggie 0.35.0).
    const event = normalizeAndAccept(state, 'aug', {
      hook_event_name: 'PreToolUse',
      tool_name: 'ask-user',
      tool_input: { questions: [{ text: 'Continue?' }] }
    })
    expect(event?.payload.state).toBe('waiting')
  })

  it('surfaces PostToolUse tool_error as lastAssistantMessage while staying working', () => {
    const event = normalizeAndAccept(state, 'aug', {
      hook_event_name: 'PostToolUse',
      tool_name: 'view',
      tool_output: 'ok',
      tool_error: 'boom'
    })
    expect(event?.payload.state).toBe('working')
    expect(event?.payload.lastAssistantMessage).toBe('boom')
  })

  it('falls back to tool_output when PostToolUse has no tool_error', () => {
    const event = normalizeAndAccept(state, 'aug', {
      hook_event_name: 'PostToolUse',
      tool_name: 'view',
      tool_output: 'file contents'
    })
    expect(event?.payload.lastAssistantMessage).toBe('file contents')
  })

  it('resolves the prompt from nested conversation.userPrompt on Stop and marks it explicit', () => {
    const event = normalizeAndAccept(state, 'aug', {
      hook_event_name: 'Stop',
      agent_stop_cause: 'end_turn',
      conversation: { userPrompt: 'fix the bug', agentTextResponse: 'done, fixed it' }
    })
    expect(event?.payload.state).toBe('done')
    expect(event?.payload.prompt).toBe('fix the bug')
    expect(event?.payload.lastAssistantMessage).toBe('done, fixed it')
    expect(event?.hasExplicitPrompt).toBe(true)
  })

  it('marks interrupted when agent_stop_cause is interrupted', () => {
    const event = normalizeAndAccept(state, 'aug', {
      hook_event_name: 'Stop',
      agent_stop_cause: 'interrupted'
    })
    expect(event?.payload.interrupted).toBe(true)
  })

  it('does not treat max_iterations/error stop causes as interrupted', () => {
    const event = normalizeAndAccept(state, 'aug', {
      hook_event_name: 'Stop',
      agent_stop_cause: 'max_iterations'
    })
    expect(event?.payload.state).toBe('done')
    expect(event?.payload.interrupted).toBeUndefined()
  })

  it('maps SessionEnd to a terminal done row', () => {
    const event = normalizeAndAccept(state, 'aug', { hook_event_name: 'SessionEnd' })
    expect(event?.payload.state).toBe('done')
    expect(event?.payload.sessionBoundary).toBe(true)
  })

  it('does not reset the cached prompt across PreToolUse within the same turn', () => {
    normalizeAndAccept(state, 'aug', {
      hook_event_name: 'SessionStart'
    })
    state.lastPromptByPaneKey.set(PANE_KEY, 'earlier prompt')
    const event = normalizeAndAccept(state, 'aug', {
      hook_event_name: 'PreToolUse',
      tool_name: 'view',
      tool_input: {}
    })
    expect(event?.payload.prompt).toBe('earlier prompt')
  })
})
