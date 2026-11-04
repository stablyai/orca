import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeHookPayload } from './normalize-hook-payload'
import { clearGrokSessionPathLookupCacheForTests } from '../../grok-session-paths'
import { PANE_KEY } from './agent-hook-listener-test-harness'

describe('shared agent-hook-listener', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  afterEach(() => {
    clearGrokSessionPathLookupCacheForTests()
    vi.unstubAllEnvs()
  })

  it.each([0, 1, 2, 3])(
    'normalizes %i leading Cursor BOMs to a working state (#21421)',
    (count) => {
      const event = normalizeHookPayload(
        state,
        'cursor',
        {
          paneKey: PANE_KEY,
          payload: `${'\uFEFF'.repeat(count)}{"hook_event_name":"beforeSubmitPrompt","prompt":"Synthetic Cursor prompt"}`
        },
        'production'
      )

      expect(event?.payload).toMatchObject({
        agentType: 'cursor',
        state: 'working',
        prompt: 'Synthetic Cursor prompt'
      })
      expect(event?.hookEventName).toBe('beforeSubmitPrompt')
    }
  )

  // Only contiguous leading BOMs are transport framing; misplaced BOMs remain invalid JSON.
  it('still rejects malformed JSON after leading BOMs are removed', () => {
    const bom = '\uFEFF'
    const body = '{"hook_event_name":"beforeSubmitPrompt"}'
    for (const payload of [
      `${bom}${bom}not json`,
      ` ${bom}${body}`,
      `{"hook_event_name"${bom}:"beforeSubmitPrompt"}`
    ]) {
      const event = normalizeHookPayload(
        state,
        'cursor',
        { paneKey: PANE_KEY, payload },
        'production'
      )
      expect(event).toBeNull()
    }
  })

  it('captures the full AskUserQuestion tool input as interactivePrompt (untruncated)', () => {
    const questions = {
      questions: Array.from({ length: 4 }, (_, i) => ({
        question: `Question ${i} ${'detail '.repeat(40)}`,
        options: ['option one', 'option two', 'option three']
      }))
    }
    const event = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_input: questions
        }
      },
      'production'
    )

    expect(event?.payload.toolName).toBe('AskUserQuestion')
    // AskUserQuestion needs human input even when auto-allowed; show waiting.
    expect(event?.payload.state).toBe('waiting')
    const expected = JSON.stringify(questions)
    expect(event?.payload.interactivePrompt).toBe(expected)
    // Keep the full interactive prompt beyond the 160-character tool preview.
    expect(expected.length).toBeGreaterThan(200)
    expect(event?.payload.interactivePrompt!.length).toBe(expected.length)
  })

  it('clears interactivePrompt on the next tool event after AskUserQuestion', () => {
    normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_input: { questions: [{ question: 'Pick', options: ['a'] }] }
        }
      },
      'production'
    )
    const next = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'ls' }
        }
      },
      'production'
    )
    expect(next?.payload.toolName).toBe('Bash')
    expect(next?.payload.toolInput).toBe('ls')
    expect(next?.payload.interactivePrompt).toBeUndefined()
  })

  it('keeps AskUserQuestion visible through a late parallel sibling completion', () => {
    const questions = { questions: [{ question: 'Pick', options: ['a', 'b'] }] }
    const question = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_use_id: 'tool-question',
          tool_input: questions
        }
      },
      'production'
    )
    normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PermissionRequest',
          tool_name: 'AskUserQuestion',
          tool_input: questions
        }
      },
      'production'
    )
    const siblingCompletion = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_use_id: 'tool-sibling',
          tool_input: { command: 'sleep 5' }
        }
      },
      'production'
    )

    expect(siblingCompletion?.payload).toMatchObject({
      state: 'waiting',
      toolName: 'AskUserQuestion',
      interactivePrompt: question?.payload.interactivePrompt
    })
  })

  it('clears AskUserQuestion when its own PostToolUse arrives', () => {
    normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_use_id: 'tool-question',
          tool_input: { questions: [{ question: 'Pick', options: ['a', 'b'] }] }
        }
      },
      'production'
    )
    const answered = normalizeHookPayload(
      state,
      'claude',
      {
        paneKey: PANE_KEY,
        payload: {
          hook_event_name: 'PostToolUse',
          tool_name: 'AskUserQuestion',
          tool_use_id: 'tool-question'
        }
      },
      'production'
    )

    expect(answered?.payload.state).toBe('working')
    expect(answered?.payload.interactivePrompt).toBeUndefined()
  })
})
