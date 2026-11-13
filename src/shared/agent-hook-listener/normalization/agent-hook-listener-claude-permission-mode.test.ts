import { beforeEach, describe, expect, it } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeAndAccept } from './agent-hook-listener-test-harness'

describe("Claude's permission mode on the pane's provider session", () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  function post(payload: Record<string, unknown>): string | undefined {
    return normalizeAndAccept(state, 'claude', {
      session_id: '6f1f0b5e-2c3d-4e5f-8a9b-0c1d2e3f4a5b',
      ...payload
    })?.providerSession?.permissionMode
  }

  // A hand-typed resume of the same conversation may drop the bypass the last process had.
  it('keeps the mode across /clear but not into a fresh resume of the same conversation', () => {
    post({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hi',
      permission_mode: 'bypassPermissions'
    })
    expect(post({ hook_event_name: 'SessionStart', source: 'clear' })).toBe('bypassPermissions')
    expect(post({ hook_event_name: 'SessionStart', source: 'resume' })).toBeUndefined()
  })
})
