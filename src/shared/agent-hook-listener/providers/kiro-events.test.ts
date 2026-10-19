import { beforeEach, describe, expect, it } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeAndAccept } from '../../agent-hook-listener-test-harness'

// Payload shapes copied from a live kiro-cli 2.28 TUI run with hooks on a custom agent.
const base = { cwd: '/tmp/ws', session_id: 'f6fe70d7-a1b2-4c3d-9e8f-001122334455' }

function event(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...base, hook_event_name: name, ...extra }
}

describe('normalizeKiroEvent', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  it('lands an idle row when the agent spawns', () => {
    const spawned = normalizeAndAccept(state, 'kiro', event('agentSpawn'))
    expect(spawned?.payload.state).toBe('done')
    expect(spawned?.payload.agentType).toBe('kiro')
  })

  it('reports a prompt as working and stop as done with the final reply', () => {
    const submitted = normalizeAndAccept(
      state,
      'kiro',
      event('userPromptSubmit', { prompt: 'read note.txt' })
    )
    expect(submitted?.payload.state).toBe('working')
    expect(submitted?.payload.prompt).toBe('read note.txt')

    const stopped = normalizeAndAccept(
      state,
      'kiro',
      event('stop', { assistant_response: 'hello' })
    )
    expect(stopped?.payload.state).toBe('done')
    expect(stopped?.payload.prompt).toBe('read note.txt')
    expect(stopped?.payload.lastAssistantMessage).toBe('hello')
  })

  it('surfaces the running tool while working', () => {
    normalizeAndAccept(state, 'kiro', event('userPromptSubmit', { prompt: 'read it' }))
    const pre = normalizeAndAccept(
      state,
      'kiro',
      event('preToolUse', {
        tool_name: 'read',
        tool_input: { operations: [{ mode: 'Line', path: '/tmp/ws/note.txt' }] }
      })
    )
    expect(pre?.payload.state).toBe('working')
    expect(pre?.payload.toolName).toBe('read')

    const post = normalizeAndAccept(
      state,
      'kiro',
      event('postToolUse', {
        tool_name: 'read',
        tool_input: { operations: [{ mode: 'Line', path: '/tmp/ws/note.txt' }] },
        tool_response: { items: [{ Text: 'hello' }] }
      })
    )
    expect(post?.payload.state).toBe('working')
  })

  it('ignores event names Kiro does not document', () => {
    expect(normalizeAndAccept(state, 'kiro', event('Stop'))).toBeNull()
  })
})
