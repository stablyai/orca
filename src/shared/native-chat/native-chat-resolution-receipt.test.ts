import { describe, expect, it } from 'vitest'
import type { AgentJournalQuestionItem } from '../agent-session/journal/agent-session-journal-types'
import { nativeChatReceiptAnswers } from './native-chat-resolution-receipt'

const question = (n: number) => ({
  id: `q${n}`,
  question: `Question ${n}?`,
  multiSelect: false,
  options: [{ id: `q${n}:a`, label: `Answer ${n}` }]
})

describe('resolution receipt answers', () => {
  it('lists the answered questions of a partly answered set and leaves skipped ones out', () => {
    const body: AgentJournalQuestionItem = {
      kind: 'question',
      question: 'Question 1?',
      options: [],
      questions: [question(1), question(2)],
      resolution: {
        state: 'resolved',
        selectedOptionId: 'question-group:[]',
        answers: [
          { questionId: 'q1', optionIds: [] },
          { questionId: 'q2', optionIds: ['q2:a'] }
        ],
        resolvedBy: 'desktop-renderer',
        resolvedAt: 1
      }
    }

    expect(nativeChatReceiptAnswers(body)).toEqual([
      { key: 'q2', question: 'Question 2?', answer: 'Answer 2' }
    ])
  })
})
