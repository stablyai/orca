import { formatAsyncQuestionAnswer } from './native-chat-async-questions'
import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { deriveJournalAsyncQuestions } from './native-chat-async-question-facts'
import {
  nativeChatAsyncQuestionKey,
  reduceNativeChatAsyncQuestionsView,
  pendingAsyncQuestionGroups
} from './native-chat-pending-async-questions'

function item(sequence: number, body: AgentJournalRenderItem['body']): AgentJournalRenderItem {
  return { itemId: `row-${sequence}`, revision: 1, sequence, observedAt: sequence, body }
}
const ask = item(1, {
  kind: 'message',
  role: 'assistant',
  blocks: [
    {
      type: 'text',
      text: 'Choose',
      asyncQuestionId: 'provider-call',
      asyncQuestions: [
        { title: 'Branch?', options: ['main'] },
        { title: 'Color?', options: ['blue'] }
      ]
    }
  ]
})

it('retires only the questions named by Codex’s editor even when journal IDs differ', () => {
  const reply = item(2, {
    kind: 'message',
    role: 'user',
    blocks: [
      {
        type: 'text',
        text: `<send_user_message_question_reply>${JSON.stringify({ questionItemId: nativeChatAsyncQuestionKey('provider-call', 0), question: 'Branch?', answer: 'main' })}</send_user_message_question_reply>`
      }
    ]
  })
  expect(deriveJournalAsyncQuestions([ask, reply], []).map((q) => q.title)).toEqual(['Color?'])
  expect(deriveJournalAsyncQuestions([ask, { ...reply, agentId: 'child' }], [])).toHaveLength(2)
})

it('keeps pending groups through disconnects, replaces them authoritatively and falls back for old hosts', () => {
  const ready = { state: 'ready' as const, questions: deriveJournalAsyncQuestions([ask], []) }
  expect(pendingAsyncQuestionGroups(ready)).toEqual([
    {
      key: 'row-1',
      questions: [
        { title: 'Branch?', options: ['main'] },
        { title: 'Color?', options: ['blue'] }
      ]
    }
  ])
  expect(reduceNativeChatAsyncQuestionsView(ready, { type: 'error' })).toBe(ready)
  expect(
    reduceNativeChatAsyncQuestionsView(ready, { type: 'snapshot', error: 'unavailable' })
  ).toBe(ready)
  expect(reduceNativeChatAsyncQuestionsView(ready, { type: 'appended' })).toBe(ready)
  expect(
    pendingAsyncQuestionGroups(
      reduceNativeChatAsyncQuestionsView(ready, {
        type: 'appended',
        asyncQuestions: { state: 'ready', questions: [] }
      })
    )
  ).toEqual([])
  expect(
    pendingAsyncQuestionGroups(reduceNativeChatAsyncQuestionsView(ready, { type: 'snapshot' }))
  ).toBeUndefined()
})

it('retires a replaced file’s cards while its replacement is reconstructed', () => {
  const ready = { state: 'ready' as const, questions: deriveJournalAsyncQuestions([ask], []) }
  expect(
    pendingAsyncQuestionGroups(
      reduceNativeChatAsyncQuestionsView(ready, {
        type: 'replacement',
        asyncQuestions: { state: 'pending' }
      })
    )
  ).toEqual([])
})

it('never interprets an answer as a slash command named by the question title', () => {
  expect(
    formatAsyncQuestionAnswer(
      [{ title: '/compact', options: ['yes'] }],
      [{ indices: [0], other: '' }]
    )
  ).toBe('Question: /compact\nyes')
})
