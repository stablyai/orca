import { beforeEach, describe, expect, it } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeAndAccept } from '../normalization/agent-hook-listener-test-harness'

// Real @deepseek-ai/dsh-hooks-claude-code0.1.5-rc.3 payloads: session/cwd/event fields and empty transcript_path, mounted through DSH_HOME/cordis.patch.yml.
const SESSION_ID = '9478e2d8-29bc-4009-ab32-657efa2bd763'

const base = { transcript_path: '', cwd: '/tmp/ws', session_id: SESSION_ID }

function event(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...base, hook_event_name: name, ...extra }
}

describe('normalizeDshEvent', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  it('reports ask_user_question as waiting and its answer as working again', () => {
    normalizeAndAccept(state, 'dsh', event('UserPromptSubmit', { prompt: 'pick a colour' }))
    const asked = normalizeAndAccept(
      state,
      'dsh',
      event('PreToolUse', {
        tool_name: 'ask_user_question',
        tool_input: {
          questions: [{ header: 'Colour', question: 'Which one?', options: [{ label: 'Blue' }] }]
        },
        tool_use_id: 'call-2'
      })
    )
    // DSH has no approval/notification hooks; ask_user_question is its only structured human-input signal.
    expect(asked?.payload.state).toBe('waiting')
    expect(asked?.payload.interactivePrompt).toContain('Which one?')

    const answered = normalizeAndAccept(
      state,
      'dsh',
      event('PostToolUse', {
        tool_name: 'ask_user_question',
        tool_use_id: 'call-2',
        tool_response: 'Blue'
      })
    )
    expect(answered?.payload.state).toBe('working')
  })

  it('leaves a session-boundary done for SessionStart, not a completion', () => {
    const started = normalizeAndAccept(state, 'dsh', event('SessionStart', { source: 'startup' }))
    expect(started?.payload.state).toBe('done')
    expect(started?.payload.sessionBoundary).toBe(true)
    // A compact restart shares the lead's session but runs mid-turn.
    expect(
      normalizeAndAccept(state, 'dsh', event('SessionStart', { source: 'compact' }))
    ).toBeNull()
  })

  it('drops child-agent hooks so a subagent cannot finish the lead pane', () => {
    const CHILD_SESSION_ID = 'child-session-0000-4000-8000-000000000001'
    const child = (name: string, extra: Record<string, unknown> = {}) =>
      event(name, { session_id: CHILD_SESSION_ID, ...extra })

    normalizeAndAccept(state, 'dsh', event('UserPromptSubmit', { prompt: 'delegate this' }))
    expect(
      normalizeAndAccept(state, 'dsh', child('SessionStart', { source: 'startup' }))
    ).toBeNull()
    expect(normalizeAndAccept(state, 'dsh', child('PreToolUse', { tool_name: 'bash' }))).toBeNull()
    expect(normalizeAndAccept(state, 'dsh', child('Stop'))).toBeNull()

    const leadStop = normalizeAndAccept(state, 'dsh', event('Stop'))
    expect(leadStop?.payload.state).toBe('done')
  })

  it('adopts a remembered child session when the pane resumes it as the lead', () => {
    const CHILD_SESSION_ID = 'child-session-0000-4000-8000-000000000002'
    const child = (name: string, extra: Record<string, unknown> = {}) =>
      event(name, { session_id: CHILD_SESSION_ID, ...extra })

    normalizeAndAccept(state, 'dsh', event('UserPromptSubmit', { prompt: 'lead' }))
    expect(
      normalizeAndAccept(state, 'dsh', child('SessionStart', { source: 'startup' }))
    ).toBeNull()

    const resumed = normalizeAndAccept(state, 'dsh', child('SessionStart', { source: 'resume' }))
    expect(resumed?.payload.state).toBe('done')
    expect(normalizeAndAccept(state, 'dsh', child('Stop'))?.payload.state).toBe('done')
  })
})
