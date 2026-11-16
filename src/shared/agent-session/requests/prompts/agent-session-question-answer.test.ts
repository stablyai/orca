import { describe, expect, it } from 'vitest'
import {
  decodeAgentSessionQuestionAnswers,
  isValidAgentSessionQuestionAnswers,
  type AgentSessionQuestionAnswer
} from './agent-session-question-answer'

const GROUP_ANSWER_PREFIX = 'question-group:'

describe('agent-session grouped question answers', () => {
  const answers: AgentSessionQuestionAnswer[] = [
    { questionId: 'q1', optionIds: ['target-web', 'target-mobile'] },
    { questionId: 'q2', optionIds: [], other: 'SSH host' }
  ]

  it('accepts the previous fully percent-encoded representation', () => {
    const encoded = `${GROUP_ANSWER_PREFIX}${encodeURIComponent(JSON.stringify(answers))}`

    expect(decodeAgentSessionQuestionAnswers(encoded)).toEqual(answers)
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
    expect(isValidAgentSessionQuestionAnswers(questions, answers.toReversed())).toBe(true)
    const invalid = [
      [],
      [...answers, { questionId: 'q3', optionIds: [] }],
      [answers[0]!, answers[0]!],
      [{ ...answers[0]!, questionId: 'unknown' }, answers[1]!],
      [{ ...answers[0]!, optionIds: [] }, answers[1]!],
      [{ ...answers[0]!, other: 'not offered' }, answers[1]!]
    ]
    for (const candidate of invalid) {
      expect(isValidAgentSessionQuestionAnswers(questions, candidate)).toBe(false)
    }
    expect(
      isValidAgentSessionQuestionAnswers(
        [{ ...questions[0]!, multiSelect: false }, questions[1]!],
        answers
      )
    ).toBe(false)
    expect(
      isValidAgentSessionQuestionAnswers(questions, [
        { questionId: 'q1', optionIds: ['unknown'] },
        answers[1]!
      ])
    ).toBe(false)
  })
})
