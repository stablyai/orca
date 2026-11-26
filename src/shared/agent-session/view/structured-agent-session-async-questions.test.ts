import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import { newestOpenStructuredAgentSessionAsyncQuestion } from './structured-agent-session-async-questions'

it('keeps an unanswered question across Feishu turn steering but closes it for an answer or new turn', () => {
  const question: AgentJournalRenderItem = {
    itemId: 'question',
    sequence: 1,
    revision: 0,
    observedAt: 1,
    turnScope: { kind: 'turn', turnItemId: 'turn' },
    body: {
      kind: 'message',
      role: 'assistant',
      blocks: [
        {
          type: 'tool-call',
          name: 'request_user_input_async',
          callId: 'ask',
          input: { questions: [{ title: 'Choose', options: ['Yes', 'No'] }] }
        }
      ]
    }
  }
  const user = (
    sequence: number,
    deliveryId: string,
    turnItemId = 'turn'
  ): AgentJournalRenderItem => ({
    itemId: deliveryId,
    sequence,
    revision: 0,
    observedAt: sequence,
    turnScope: { kind: 'turn', turnItemId },
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Additional context' }],
      connectorDelivery: {
        account: 'account',
        conversation: { source: 'feishu-local', externalId: 'lane' },
        deliveryId
      }
    }
  })
  const steers = [question, user(2, 'om_one'), user(3, 'om_two'), user(4, 'om_three')]
  expect(newestOpenStructuredAgentSessionAsyncQuestion(steers, [])?.itemId).toBe('question')
  expect(
    newestOpenStructuredAgentSessionAsyncQuestion([...steers, user(5, 'om_orca_choice_answer')], [])
  ).toBeUndefined()
  expect(
    newestOpenStructuredAgentSessionAsyncQuestion([...steers, user(5, 'om_new', 'new-turn')], [])
  ).toBeUndefined()
  const native = user(5, 'native-answer')
  if (native.body.kind === 'message') {
    delete native.body.connectorDelivery
  }
  expect(newestOpenStructuredAgentSessionAsyncQuestion([...steers, native], [])).toBeUndefined()
})
