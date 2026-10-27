import type {
  AgentJournalApprovalItem,
  AgentJournalQuestionItem
} from './agent-session-journal-types'
import {
  agentSessionPromptQuestions,
  legacyAgentSessionQuestionAnswers
} from './agent-session-question-answer'
import type { NativeChatAskRowSubject } from './native-chat/input/native-chat-ask-row'

/** Desktop's fallbacks for its translations; the phone's words. */
export const NATIVE_CHAT_RECEIPT_COPY = {
  emptyAnswer: 'Empty answer',
  unavailable: 'Selected answer unavailable',
  resolved: 'Resolved',
  cancelled: 'Cancelled',
  resolver: 'Answered on {{device}}',
  cancelledBy: 'Cancelled on {{device}}'
} as const

export type NativeChatResolvedPrompt = AgentJournalApprovalItem | AgentJournalQuestionItem
/** `answer` is '' for an explicitly empty text answer and null when the answer cannot be read. */
export type NativeChatReceiptAnswer = { question: string | null; answer: string | null }

export function nativeChatReceiptAnswers(
  body: NativeChatResolvedPrompt
): NativeChatReceiptAnswer[] {
  if (body.resolution.state !== 'resolved') {
    return []
  }
  const selected = body.resolution.selectedOptionId
  if (body.kind === 'question') {
    // Rows written before hosts recorded structured answers carry only the packed form.
    const answers =
      body.resolution.answers ??
      (selected ? legacyAgentSessionQuestionAnswers(body, selected) : null)
    return agentSessionPromptQuestions(body).map((question) => {
      const answer = answers?.find((entry) => entry.questionId === question.id)
      const labels = answer?.optionIds.map(
        (id) => question.options.find((option) => option.id === id)?.label
      )
      const valid = labels?.every((label) => label !== undefined)
      const parts = [...(labels ?? []), ...(answer?.other?.trim() ? [answer.other] : [])]
      return {
        question: body.questions ? question.question : null,
        answer: !valid
          ? null
          : parts.length > 0
            ? parts.join(' · ')
            : answer?.other !== undefined
              ? ''
              : null
      }
    })
  }
  const option = body.options.find((option) => option.id === selected)
  return [{ question: null, answer: option?.label ?? null }]
}

/** Null for an approval, which shows its title instead. */
export function nativeChatReceiptSubject(
  body: NativeChatResolvedPrompt
): NativeChatAskRowSubject | null {
  if (body.kind !== 'question') {
    return null
  }
  if (body.questions && body.questions.length > 1) {
    return { kind: 'questions', questions: body.questions.map((entry) => entry.question) }
  }
  // After resolution keep Claude’s grouped heading for a lone multi-select to avoid repeating the question above its answer.
  return {
    kind: 'question',
    text:
      body.resolution.state !== 'pending' &&
      body.questions?.length === 1 &&
      body.questions[0]?.question !== body.question
        ? body.question
        : (body.questions?.[0]?.question ?? body.question)
  }
}

/** The question line above an answer, or null where the ask row already says it. */
export function nativeChatReceiptAnswerHeading(
  subject: NativeChatAskRowSubject | null,
  answer: NativeChatReceiptAnswer
): string | null {
  return answer.question && !(subject?.kind === 'question' && answer.question === subject.text)
    ? answer.question
    : null
}
