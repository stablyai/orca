import { describe, expect, it } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeHookPayload } from './normalize-hook-payload'
import { makePaneKey } from '../../workspace-layout/stable-pane-id'

const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

function claudeEvent(state: HookListenerState, payload: Record<string, unknown>) {
  return normalizeHookPayload(state, 'claude', { paneKey: PANE, payload }, 'production')?.payload
}

describe('Claude StopFailure status', () => {
  it("keeps the failed turn's error and message on the row until the next turn", () => {
    const state = createHookListenerState()
    claudeEvent(state, { hook_event_name: 'UserPromptSubmit', prompt: 'work' })
    const failed = claudeEvent(state, {
      hook_event_name: 'StopFailure',
      error: 'rate_limit',
      last_assistant_message: "You've hit your session limit · resets 3pm"
    })
    expect(failed?.mainAgent).toMatchObject({
      state: 'done',
      outcome: 'failure',
      failure: { error: 'rate_limit', message: "You've hit your session limit · resets 3pm" }
    })
    claudeEvent(state, { hook_event_name: 'UserPromptSubmit', prompt: 'again' })
    const finished = claudeEvent(state, { hook_event_name: 'Stop' })
    expect(finished?.mainAgent?.state).toBe('done')
    expect(finished?.mainAgent?.failure).toBeUndefined()
  })
})
