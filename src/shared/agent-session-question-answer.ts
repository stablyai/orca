import type { AgentJournalQuestion, AgentJournalQuestionItem } from './agent-session-journal-types'

const GROUP_ANSWER_PREFIX = 'question-group:'

/** A single-question item has no question list; the client and host must agree on its id. */
const SINGLE_QUESTION_ID = 'q1'

/** Largest typed answer to one question, in UTF-8 bytes. */
export const AGENT_SESSION_QUESTION_ANSWER_MAX_BYTES = 64 * 1024

export type AgentSessionQuestionAnswer = {
  questionId: string
  optionIds: string[]
  other?: string
}

/** What a client chose on a prompt: a decision id for an approval, per-question answers for a question. */
export type AgentSessionPromptResponse =
  | { kind: 'option'; optionId: string }
  | { kind: 'answers'; answers: AgentSessionQuestionAnswer[] }

/** The questions an item asks: its grouped list, or the item itself as one question. */
export function agentSessionPromptQuestions(
  body: Pick<AgentJournalQuestionItem, 'question' | 'options' | 'questions' | 'freeTextQuestionId'>
): AgentJournalQuestion[] {
  if (body.questions) {
    return body.questions
  }
  return [
    {
      id: body.freeTextQuestionId ?? SINGLE_QUESTION_ID,
      question: body.question,
      options: body.options,
      multiSelect: false,
      ...(body.freeTextQuestionId ? { freeTextQuestionId: body.freeTextQuestionId } : {})
    }
  ]
}

function encodeLegacyFreeTextAnswer(questionId: string, answer: string): string {
  return `${encodeURIComponent(questionId)}:${encodeURIComponent(answer)}`
}

function decodeLegacyFreeTextAnswer(
  optionId: string
): { questionId: string; answer: string } | null {
  const separator = optionId.indexOf(':')
  if (separator <= 0) {
    return null
  }
  try {
    return {
      questionId: decodeURIComponent(optionId.slice(0, separator)),
      answer: decodeURIComponent(optionId.slice(separator + 1))
    }
  } catch {
    return null
  }
}

/**
 * The answer packed into one option-id string, the only form older peers read: hosts that
 * predate structured answers take it as `optionId`, and older clients render receipts from it.
 */
export function legacyAgentSessionSelectedOptionId(
  body: Pick<AgentJournalQuestionItem, 'questions'>,
  answers: readonly AgentSessionQuestionAnswer[]
): string | null {
  if (body.questions) {
    return encodeAgentSessionQuestionAnswers(answers)
  }
  const [answer] = answers
  if (!answer || answers.length !== 1) {
    return null
  }
  const other = answer.other?.trim()
  return (
    answer.optionIds[0] ?? (other ? encodeLegacyFreeTextAnswer(answer.questionId, other) : null)
  )
}

/** Reads an answer an older client packed into `optionId`. */
export function legacyAgentSessionQuestionAnswers(
  body: Pick<AgentJournalQuestionItem, 'question' | 'options' | 'questions' | 'freeTextQuestionId'>,
  optionId: string
): AgentSessionQuestionAnswer[] | null {
  const grouped = body.questions ? decodeAgentSessionQuestionAnswers(optionId) : null
  if (grouped) {
    return grouped
  }
  const questions = agentSessionPromptQuestions(body)
  const questionId = questions.length === 1 ? questions[0]!.id : null
  if (!questionId) {
    return null
  }
  if (body.options.some((option) => option.id === optionId)) {
    return [{ questionId, optionIds: [optionId] }]
  }
  const freeText = decodeLegacyFreeTextAnswer(optionId)
  return body.freeTextQuestionId &&
    freeText?.questionId === body.freeTextQuestionId &&
    freeText.answer.trim().length > 0
    ? [{ questionId, optionIds: [], other: freeText.answer }]
    : null
}

export function encodeAgentSessionQuestionAnswers(
  answers: readonly AgentSessionQuestionAnswer[]
): string {
  // RPC already JSON-frames this value; escaping `%` alone preserves decodeURIComponent readers.
  return `${GROUP_ANSWER_PREFIX}${JSON.stringify(answers).replaceAll('%', '%25')}`
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
