import {
  PENDING_MESSAGE_QUESTION,
  type MessageQuestionOccurrence
} from './message-question-occurrence'

export function messageQuestionFixture(
  id: string,
  overrides: Partial<MessageQuestionOccurrence> = {}
): MessageQuestionOccurrence {
  return {
    id,
    sourceId: 'host-source',
    context: 'context',
    sourceRowId: id,
    callSlot: 0,
    order: [1, 0],
    timestamp: null,
    turnId: null,
    responseMode: 'message',
    questions: [
      {
        question: 'Which color?',
        multiSelect: false,
        options: [{ label: 'Red' }, { label: 'Blue' }]
      }
    ],
    resolution: PENDING_MESSAGE_QUESTION,
    ...overrides
  }
}
