import { expect, it } from 'vitest'
import { createHookListenerState } from '../../listener-state'
import { trackCodexAsyncQuestions } from './codex-async-questions'

it('settles a call after answering its parsed questions when invalid entries were discarded', () => {
  const state = createHookListenerState()
  trackCodexAsyncQuestions(state, 'pane', 'PreToolUse', {
    tool_name: 'request_user_input_async',
    tool_use_id: 'call',
    tool_input: { questions: [{}, { title: 'Region?' }] }
  })

  expect(
    trackCodexAsyncQuestions(state, 'pane', 'UserPromptSubmit', {
      prompt:
        '<send_user_message_question_reply>[{"questionItemId":"[\\"request_user_input_async\\",\\"call\\",0]","answer":"Brazil"}]</send_user_message_question_reply>'
    })
  ).toBeUndefined()
})
