import { expect, it } from 'vitest'
import { normalizeHookPayload } from './normalize-hook-payload'
import { createHookListenerState } from '../listener-state'
import { makePaneKey } from '../../workspace-layout/stable-pane-id'

it.each([
  ['AskUserQuestion', { questions: [{ question: 'Which branch?', options: [] }] }],
  ['Bash', { command: 'echo test' }]
])('does not carry a previous %s into an unnamed permission request', (toolName, toolInput) => {
  const state = createHookListenerState()
  const paneKey = makePaneKey('chat', '11111111-1111-4111-8111-111111111111')
  const hook = (payload: Record<string, unknown>) =>
    normalizeHookPayload(state, 'claude', { paneKey, payload }, 'production')?.payload
  hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Start' })
  const previous = hook({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput
  })
  expect(previous?.toolName).toBe(toolName)
  const waiting = hook({ hook_event_name: 'PermissionRequest' })
  expect(waiting?.state).toBe('waiting')
  expect(waiting?.toolName).toBeUndefined()
  expect(waiting?.toolInput).toBeUndefined()
  expect(waiting?.interactivePrompt).toBeUndefined()
})
