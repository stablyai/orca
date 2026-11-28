import { expect, it } from 'vitest'
import { createHookListenerState } from '../../listener-state'
import { normalizeHermesEvent } from './hermes-events'

// #51676: Hermes' smart-approval guardian fires approval hooks while no person is asked.
it('only marks waiting for approvals that reach a person', () => {
  const state = createHookListenerState()
  const send = (eventName: string, payload: Record<string, unknown> = {}) =>
    normalizeHermesEvent(state, eventName, '', 'pane', {
      hook_event_name: eventName,
      session_id: 's1',
      ...payload
    })
  const approval = { command: 'rm -rf build', session_key: 's1' }

  send('pre_llm_call', { platform: 'cli', user_message: 'clean up' })
  expect(send('pre_approval_request', { ...approval, surface: 'smart' })).toBeNull()
  expect(
    send('post_approval_response', { ...approval, surface: 'smart', choice: 'smart_approve' })
  ).toBeNull()

  // A smart escalate fires no smart post; the human-surface request follows.
  expect(send('pre_approval_request', { ...approval, surface: 'smart' })).toBeNull()
  expect(send('pre_approval_request', { ...approval, surface: 'cli' })).toMatchObject({
    state: 'waiting'
  })
  expect(
    send('post_approval_response', { ...approval, surface: 'cli', choice: 'once' })
  ).toMatchObject({ state: 'working' })
})
