import type { AgentJournalQuestion } from './agent-session-journal-types'

export function encodeAgentSessionQuestionAnswer(questionId: string, answer: string): string {
  return `${encodeURIComponent(questionId)}:${encodeURIComponent(answer)}`
}

const GROUP_ANSWER_PREFIX = 'question-group:'

export type AgentSessionQuestionAnswer = {
  questionId: string
  optionIds: string[]
  other?: string
}

export function encodeAgentSessionQuestionAnswers(
  answers: readonly AgentSessionQuestionAnswer[]
): string {
  return `${GROUP_ANSWER_PREFIX}${encodeURIComponent(JSON.stringify(answers))}`
}

export function decodeAgentSessionQuestionAnswers(
  encoded: string,
  questions?: readonly AgentJournalQuestion[]
): AgentSessionQuestionAnswer[] | null {
  if (questions && encoded.startsWith('answers:')) {
    try {
      const value: unknown = JSON.parse(encoded.slice('answers:'.length))
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null
      }
      const answers: AgentSessionQuestionAnswer[] = []
      for (const [questionId, labels] of Object.entries(value)) {
        const question = questions.find((entry) => entry.id === questionId)
        if (
          !question ||
          !Array.isArray(labels) ||
          !labels.every((label) => typeof label === 'string')
        ) {
          return null
        }
        const optionIds: string[] = []
        const other: string[] = []
        for (const label of labels) {
          const option = question.options.find((entry) => entry.label === label)
          if (option) {
            optionIds.push(option.id)
          } else {
            other.push(label)
          }
        }
        if (other.length > 1) {
          return null
        }
        answers.push({ questionId, optionIds, ...(other[0] ? { other: other[0] } : {}) })
      }
      return answers
    } catch {
      return null
    }
  }
  if (!encoded.startsWith(GROUP_ANSWER_PREFIX)) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(
      decodeURIComponent(encoded.slice(GROUP_ANSWER_PREFIX.length))
    )
    if (!Array.isArray(parsed)) {
      return null
    }
    const answers = parsed.flatMap((value): AgentSessionQuestionAnswer[] => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return []
      }
      const record = value as Record<string, unknown>
      if (
        typeof record.questionId !== 'string' ||
        !Array.isArray(record.optionIds) ||
        !record.optionIds.every((optionId) => typeof optionId === 'string') ||
        (record.other !== undefined && typeof record.other !== 'string')
      ) {
        return []
      }
      return [
        {
          questionId: record.questionId,
          optionIds: record.optionIds,
          ...(typeof record.other === 'string' ? { other: record.other } : {})
        }
      ]
    })
    return answers.length === parsed.length ? answers : null
  } catch {
    return null
  }
}

export function isValidAgentSessionQuestionAnswers(
  questions: readonly AgentJournalQuestion[],
  answers: readonly AgentSessionQuestionAnswer[]
): boolean {
  if (answers.length !== questions.length) {
    return false
  }
  const byId = new Map(answers.map((answer) => [answer.questionId, answer]))
  if (byId.size !== answers.length) {
    return false
  }
  return questions.every((question) => {
    const answer = byId.get(question.id)
    if (!answer) {
      return false
    }
    const offered = new Set(question.options.map((option) => option.id))
    if (answer.optionIds.some((optionId) => !offered.has(optionId))) {
      return false
    }
    const other = answer.other?.trim() ?? ''
    if (other && !question.freeTextQuestionId) {
      return false
    }
    const answerCount = answer.optionIds.length + (other ? 1 : 0)
    return answerCount > 0 && (question.multiSelect || answerCount === 1)
  })
}
