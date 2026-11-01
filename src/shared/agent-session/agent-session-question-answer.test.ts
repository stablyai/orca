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

  it('round-trips grouped answers and rejects malformed wire payloads', () => {
    expect(decodeAgentSessionQuestionAnswers(encodeAgentSessionQuestionAnswers(answers))).toEqual(
      answers
    )
    const malformed = [
      'not-grouped',
      'question-group:%',
      'question-group:not-json',
      'question-group:{}',
      `${GROUP_ANSWER_PREFIX}${JSON.stringify([answers[0], { questionId: 'q2', optionIds: [1] }])}`,
      `${GROUP_ANSWER_PREFIX}${JSON.stringify([{ questionId: 'q1', optionIds: [], other: 1 }])}`
    ]
    for (const value of malformed) {
      expect(decodeAgentSessionQuestionAnswers(value)).toBeNull()
    }
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
    expect(
      decodeWithOriginalPercentDecoder(encodeAgentSessionQuestionAnswers(unicodeAnswers))
    ).toEqual(unicodeAnswers)
  })

  it("keeps Claude's maximum choice group compact without losing selections", () => {
    const maximumSelections = Array.from({ length: 4 }, (_, questionIndex) => ({
      questionId: `q${questionIndex + 1}`,
      optionIds: Array.from(
        { length: 4 },
        (_, optionIndex) => `q${questionIndex + 1}:choice-${optionIndex + 1}`
      )
    }))

    const encoded = encodeAgentSessionQuestionAnswers(maximumSelections)
    expect(encoded.length).toBeLessThanOrEqual(512)
    expect(decodeAgentSessionQuestionAnswers(encoded)).toEqual(maximumSelections)
    expect(decodeWithOriginalPercentDecoder(encoded)).toEqual(maximumSelections)
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
