import { describe, expect, it } from 'vitest'
import {
  decodeAgentSessionQuestionAnswers,
  encodeAgentSessionQuestionAnswers,
  isValidAgentSessionQuestionAnswers,
  type AgentSessionQuestionAnswer
} from './agent-session-question-answer'

describe('agent-session grouped question answers', () => {
  const answers: AgentSessionQuestionAnswer[] = [
    { questionId: 'q1', optionIds: ['target-web', 'target-mobile'] },
    { questionId: 'q2', optionIds: [], other: 'SSH host' }
  ]

  it('round-trips grouped multi-select and free-text answers', () => {
    expect(decodeAgentSessionQuestionAnswers(encodeAgentSessionQuestionAnswers(answers))).toEqual(
      answers
    )
  })

  it('validates each grouped answer against its question shape', () => {
    const questions = [
      {
        id: 'q1',
        question: 'Targets',
        multiSelect: true,
        options: [
          { id: 'target-web', label: 'Web' },
          { id: 'target-mobile', label: 'Mobile' }
        ]
      },
      {
        id: 'q2',
        question: 'Host',
        multiSelect: false,
        options: [],
        freeTextQuestionId: 'q2'
      }
    ]

    expect(isValidAgentSessionQuestionAnswers(questions, answers)).toBe(true)
    expect(
      isValidAgentSessionQuestionAnswers(questions, [
        { questionId: 'q1', optionIds: ['unknown'] },
        answers[1]!
      ])
    ).toBe(false)
  })
})
