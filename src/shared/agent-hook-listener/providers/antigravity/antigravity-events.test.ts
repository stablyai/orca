import { expect, it } from 'vitest'
import { createHookListenerState } from '../../listener-state'
import { normalizeAntigravityEvent } from './antigravity-events'

it('distinguishes a quota stop from a successful turn that mentions the same error', () => {
  const state = createHookListenerState()
  const stop = (payload: Record<string, unknown>) =>
    normalizeAntigravityEvent(state, 'Stop', '', 'pane', payload)
  const quotaStop = {
    terminationReason: 'ERROR',
    error: 'generating and executing: RESOURCE_EXHAUSTED (code 429): Individual quota reached.',
    last_assistant_message: 'Running the baseline benchmarks.'
  }

  expect(stop({ ...quotaStop, fullyIdle: false })).toMatchObject({
    state: 'working',
    mainAgent: undefined
  })
  expect(stop({ ...quotaStop, fullyIdle: true })).toMatchObject({
    state: 'done',
    lastAssistantMessage: quotaStop.error,
    mainAgent: { state: 'done', outcome: 'failure' }
  })

  normalizeAntigravityEvent(state, 'PreInvocation', 'Try again', 'pane', {})
  expect(
    stop({
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      last_assistant_message: quotaStop.error
    })
  ).toMatchObject({ state: 'done', lastAssistantMessage: quotaStop.error, mainAgent: undefined })
})
