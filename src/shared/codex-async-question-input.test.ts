import { expect, it } from 'vitest'
import { readCodexAsyncQuestionReply } from './codex-async-question-input'

it('ignores a non-string question identity without attempting object coercion', () => {
  expect(
    readCodexAsyncQuestionReply(
      '<send_user_message_question_reply>[{"questionItemId":{"toString":null,"valueOf":null},"answer":"Yes"}]</send_user_message_question_reply>'
    )
  ).toEqual([])
})
