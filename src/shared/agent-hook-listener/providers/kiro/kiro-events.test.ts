import { expect, it } from 'vitest'
import { createHookListenerState } from '../../listener-state'
import { normalizeKiroEvent } from './kiro-events'

it('does not leave the last tool output on a Stop that carries no reply', () => {
  const state = createHookListenerState()
  const send = (eventName: string, payload: Record<string, unknown> = {}) =>
    normalizeKiroEvent(state, eventName, '', 'pane', { hook_event_name: eventName, ...payload })
  const runTool = () =>
    send('PostToolUse', { tool_name: 'shell', tool_input: {}, tool_response: 'Output: foo' })

  send('UserPromptSubmit', { prompt: 'list files' })
  expect(runTool()).toMatchObject({ lastAssistantMessage: 'Output: foo' })
  // Kiro 3's Stop sends only session_id, hook_event_name and cwd.
  const v3Stop = send('Stop', { session_id: 's1', cwd: '/repo' })
  expect(v3Stop).toMatchObject({ state: 'done' })
  expect(v3Stop?.lastAssistantMessage).toBeUndefined()

  send('UserPromptSubmit', { prompt: 'again' })
  runTool()
  expect(send('Stop', { assistant_response: 'Here are the files.' })).toMatchObject({
    state: 'done',
    lastAssistantMessage: 'Here are the files.'
  })
  // A later bare Stop keeps the real reply.
  expect(send('Stop')).toMatchObject({ lastAssistantMessage: 'Here are the files.' })
})
