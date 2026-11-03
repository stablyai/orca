import { beforeEach, describe, expect, it } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeAndAccept } from '../../agent-hook-listener-test-harness'

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
})
