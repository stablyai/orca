import { beforeEach, describe, expect, it } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeAndAccept } from '../../agent-hook-listener-test-harness'

// Real @deepseek-ai/dsh-hooks-claude-code0.1.5-rc.3 payloads: session/cwd/event fields and empty transcript_path, mounted through DSH_HOME/cordis.patch.yml.
const SESSION_ID = '9478e2d8-29bc-4009-ab32-657efa2bd763'
const CHILD_SESSION_ID = 'b1c4fb80-4f12-4a6f-9a68-7c0d5f0f5a12'

const base = { transcript_path: '', cwd: '/tmp/ws', session_id: SESSION_ID }

function event(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...base, hook_event_name: name, ...extra }
}

describe('normalizeDshEvent', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  it('reports a prompt as working and a stop as done', () => {
    const submitted = normalizeAndAccept(
      state,
      'dsh',
      event('UserPromptSubmit', { prompt: 'fix the flaky test' })
    )
    expect(submitted?.payload.state).toBe('working')
    expect(submitted?.payload.agentType).toBe('dsh')
    expect(submitted?.payload.prompt).toBe('fix the flaky test')

    const stopped = normalizeAndAccept(state, 'dsh', event('Stop', { stop_hook_active: false }))
    expect(stopped?.payload.state).toBe('done')
    // The prompt is carried across the turn so a finished row still names the work.
    expect(stopped?.payload.prompt).toBe('fix the flaky test')
  })

  it('lands an idle row on SessionStart', () => {
    const started = normalizeAndAccept(state, 'dsh', event('SessionStart', { source: 'startup' }))
    expect(started?.payload.state).toBe('done')
    expect(started?.payload.agentType).toBe('dsh')
    expect(started?.payload.sessionBoundary).toBe(true)
    const stopped = normalizeAndAccept(state, 'dsh', event('Stop', { stop_hook_active: false }))
    expect(stopped?.payload.sessionBoundary).toBeUndefined()
  })

  it('treats an ordinary tool as working and surfaces its name', () => {
    normalizeAndAccept(state, 'dsh', event('UserPromptSubmit', { prompt: 'read the readme' }))
    const pre = normalizeAndAccept(
      state,
      'dsh',
      event('PreToolUse', {
        tool_name: 'read',
        tool_input: { path: 'README.md' },
        tool_use_id: 'call-1'
      })
    )
    expect(pre?.payload.state).toBe('working')
    expect(pre?.payload.toolName).toBe('read')
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

  it('ignores subagent lifecycle events', () => {
    normalizeAndAccept(state, 'dsh', event('UserPromptSubmit', { prompt: 'delegate this' }))
    const done = normalizeAndAccept(state, 'dsh', event('Stop', {}))
    expect(done?.payload.state).toBe('done')

    // Child session IDs and constant general-purpose labels cannot distinguish lead identity; ignore their lifecycle (#22216).
    for (const name of ['SubagentStart', 'SubagentStop']) {
      expect(
        normalizeAndAccept(state, 'dsh', {
          ...base,
          session_id: CHILD_SESSION_ID,
          hook_event_name: name,
          agent_id: 'agent-7',
          agent_type: 'general-purpose'
        })
      ).toBeNull()
    }
  })
})
