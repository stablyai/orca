import { describe, expect, it } from 'vitest'
import { createHookListenerState } from '../listener-state'
import { normalizeAndAccept } from './agent-hook-listener-test-harness'

describe('hook reply candidate', () => {
  it('offers only the reply text the event itself carried, never the cached one', () => {
    const state = createHookListenerState()
    normalizeAndAccept(state, 'claude', { hook_event_name: 'UserPromptSubmit', prompt: 'go' })

    const stop = normalizeAndAccept(state, 'claude', {
      hook_event_name: 'Stop',
      last_assistant_message: 'the answer'
    })
    const next = normalizeAndAccept(state, 'claude', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/a' }
    })

    expect(stop?.replyCandidate).toBe('the answer')
    expect(next?.payload.lastAssistantMessage).toBe('the answer')
    expect(next?.replyCandidate).toBeUndefined()
  })
})
