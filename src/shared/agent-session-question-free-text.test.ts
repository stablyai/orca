import { describe, expect, it } from 'vitest'
import {
  agentSessionPromptQuestions,
  isValidAgentSessionQuestionAnswers,
  legacyAgentSessionQuestionAnswers,
  legacyAgentSessionSelectedOptionId
} from './agent-session-question-answer'

describe('provider free-text question metadata', () => {
  const body = {
    question: 'Edit the text',
    options: [],
    freeTextQuestionId: 'editor:1',
    freeTextInput: { allowEmpty: true, multiline: true, initialValue: 'first\nsecond' }
  }

  it.each(['', '  ', ' first\nsecond\u2028third\u2029fourth '])(
    'preserves the exact answer %j across the older wire form',
    (other) => {
      const answers = [{ questionId: 'editor:1', optionIds: [], other }]
      const encoded = legacyAgentSessionSelectedOptionId(body, answers)
      expect(encoded).not.toBeNull()
      expect(legacyAgentSessionQuestionAnswers(body, encoded!)).toEqual(answers)
      expect(isValidAgentSessionQuestionAnswers(agentSessionPromptQuestions(body), answers)).toBe(
        true
      )
    }
  )

  it('requires an explicitly supplied answer even when empty is allowed', () => {
    expect(
      isValidAgentSessionQuestionAnswers(agentSessionPromptQuestions(body), [
        { questionId: 'editor:1', optionIds: [] }
      ])
    ).toBe(false)
    expect(legacyAgentSessionQuestionAnswers(body, 'another:')).toBeNull()
  })

  it('keeps the previous empty-answer rejection when metadata is absent', () => {
    const legacy = {
      question: 'Provide text',
      options: [],
      freeTextQuestionId: 'q1',
      freeTextInput: undefined
    }
    const answers = [{ questionId: 'q1', optionIds: [], other: '  ' }]
    expect(isValidAgentSessionQuestionAnswers(agentSessionPromptQuestions(legacy), answers)).toBe(
      false
    )
    expect(legacyAgentSessionSelectedOptionId(legacy, answers)).toBeNull()
    expect(legacyAgentSessionQuestionAnswers(legacy, 'q1:')).toBeNull()
  })
})
