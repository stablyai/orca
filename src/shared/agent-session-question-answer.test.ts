import { describe, expect, it } from 'vitest'
import {
  decodeAgentSessionQuestionAnswers,
  encodeAgentSessionQuestionAnswers,
  isValidAgentSessionQuestionAnswers,
  type AgentSessionQuestionAnswer
} from './agent-session-question-answer'

const GROUP_ANSWER_PREFIX = 'question-group:'

function decodeWithOriginalPercentDecoder(encoded: string): unknown {
  return JSON.parse(decodeURIComponent(encoded.slice(GROUP_ANSWER_PREFIX.length)))
}

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

  it('keeps compact answers readable by the original percent-decoding contract', () => {
    expect(decodeWithOriginalPercentDecoder(encodeAgentSessionQuestionAnswers(answers))).toEqual(
      answers
    )
  })

  it('accepts the previous fully percent-encoded representation', () => {
    const encoded = `${GROUP_ANSWER_PREFIX}${encodeURIComponent(JSON.stringify(answers))}`

    expect(decodeAgentSessionQuestionAnswers(encoded)).toEqual(answers)
  })

  it('round-trips percent signs and Unicode through the compact representation', () => {
    const unicodeAnswers: AgentSessionQuestionAnswer[] = [
      {
        questionId: '進捗%',
        optionIds: ['100%:完了', '🚀'],
        other: 'café 東京 50%'
      }
    ]

    expect(
      decodeAgentSessionQuestionAnswers(encodeAgentSessionQuestionAnswers(unicodeAnswers))
    ).toEqual(unicodeAnswers)
  })

  it("fits Claude's maximum choice group within a 512-character host response bound", () => {
    const maximumSelections = Array.from({ length: 4 }, (_, questionIndex) => ({
      questionId: `q${questionIndex + 1}`,
      optionIds: Array.from(
        { length: 4 },
        (_, optionIndex) => `q${questionIndex + 1}:choice-${optionIndex + 1}`
      )
    }))

    expect(encodeAgentSessionQuestionAnswers(maximumSelections).length).toBeLessThanOrEqual(512)
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
