import type { AgentJournalQuestion } from './agent-session-journal-types'

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
  encoded: string
): AgentSessionQuestionAnswer[] | null {
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
