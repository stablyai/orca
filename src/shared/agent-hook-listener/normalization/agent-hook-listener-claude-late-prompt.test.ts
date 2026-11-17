import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeHookPayload } from './normalize-hook-payload'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { makePaneKey } from '../../workspace-layout/stable-pane-id'

const PANE_KEY = makePaneKey('claude-late-prompt', '22222222-2222-4222-8222-222222222222')
const FIRST = '0b6f1a52-2f43-4f0e-9d55-0c9f6a1e2b31'
const SECOND = '7c2e9d14-81a0-4b6b-a3c5-5e0d2f9b4a77'

// Claude runs Orca's prompt hook without waiting, so its event can arrive after the turn's Stop.
describe('Claude prompt event arriving after its turn', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  function claude(payload: Record<string, unknown>) {
    return normalizeHookPayload(
      state,
      'claude',
      { paneKey: PANE_KEY, payload: { session_id: 'session-a', ...payload } },
      'production'
    )?.payload
  }

  it('keeps a finished turn done, with its prompt label, when the prompt event lands after Stop', () => {
    expect(claude({ hook_event_name: 'Stop', prompt_id: FIRST })?.state).toBe('done')

    const late = claude({ hook_event_name: 'UserPromptSubmit', prompt_id: FIRST, prompt: 'hi' })
    expect(late).toMatchObject({ state: 'done', prompt: 'hi' })

    expect(
      claude({ hook_event_name: 'UserPromptSubmit', prompt_id: SECOND, prompt: 'next' })
    ).toMatchObject({ state: 'working', prompt: 'next' })

    // An older turn's prompt arriving late must not relabel the running turn.
    claude({ hook_event_name: 'UserPromptSubmit', prompt_id: FIRST, prompt: 'old' })
    expect(
      claude({
        hook_event_name: 'PreToolUse',
        prompt_id: SECOND,
        tool_name: 'Bash',
        tool_use_id: 't1'
      })
    ).toMatchObject({ state: 'working', prompt: 'next' })
  })

  it('runs a fast prompt then Stop in order as working then done', () => {
    expect(
      claude({ hook_event_name: 'UserPromptSubmit', prompt_id: FIRST, prompt: 'hi' })?.state
    ).toBe('working')
    expect(claude({ hook_event_name: 'Stop', prompt_id: FIRST })?.state).toBe('done')
  })

  // Recorded from Claude 2.1.325: a prompt typed mid-turn joins the running turn under its prompt_id,
  // and a background-task wakeup opens a turn under a new one.
  it('keeps a mid-turn prompt in its turn and opens a wakeup turn', () => {
    claude({ hook_event_name: 'UserPromptSubmit', prompt_id: FIRST, prompt: 'start the task' })
    claude({
      hook_event_name: 'PreToolUse',
      prompt_id: FIRST,
      tool_name: 'Bash',
      tool_use_id: 't1'
    })
    expect(
      claude({ hook_event_name: 'UserPromptSubmit', prompt_id: FIRST, prompt: 'also this' })
    ).toMatchObject({ state: 'working', prompt: 'also this' })
    expect(claude({ hook_event_name: 'Stop', prompt_id: FIRST })?.state).toBe('done')

    expect(
      claude({
        hook_event_name: 'UserPromptSubmit',
        prompt_id: SECOND,
        prompt: '<task-notification>\n<task-id>bg-1</task-id>\n</task-notification>'
      })?.state
    ).toBe('working')
  })
})
