import type {
  AgentJournalApprovalItem,
  AgentJournalQuestionItem
} from '../../../../shared/agent-session-journal-types'
import { decodeAgentSessionQuestionAnswers } from '../../../../shared/agent-session-question-answer'

export type NativeChatResolvedPrompt = AgentJournalApprovalItem | AgentJournalQuestionItem
export type NativeChatReceiptAnswer = { question: string | null; answer: string | null }

export function nativeChatReceiptAnswers(
  body: NativeChatResolvedPrompt
): NativeChatReceiptAnswer[] {
  if (body.resolution.state !== 'resolved') {
    return []
  }
  const selected = body.resolution.selectedOptionId
  if (body.kind === 'question' && body.questions) {
    const answers = selected ? decodeAgentSessionQuestionAnswers(selected) : null
    return body.questions.map((question) => {
      const answer = answers?.find((entry) => entry.questionId === question.id)
      const labels = answer?.optionIds.map(
        (id) => question.options.find((option) => option.id === id)?.label
      )
      const valid = labels?.every((label) => label !== undefined)
      return {
        question: question.question,
        answer: valid
          ? [...(labels ?? []), ...(answer?.other ? [answer.other] : [])].join(' · ') || null
          : null
      }
    })
  }
  const option = body.options.find((option) => option.id === selected)
  if (option) {
    return [{ question: null, answer: option.label }]
  }
  if (body.kind === 'question' && body.freeTextQuestionId && selected) {
    const prefix = `${encodeURIComponent(body.freeTextQuestionId)}:`
    if (selected.startsWith(prefix)) {
      try {
        return [
          { question: null, answer: decodeURIComponent(selected.slice(prefix.length)) || null }
        ]
      } catch {
        // Malformed persisted answers remain readable as an unavailable selection.
      }
    }
  }
  return [{ question: null, answer: null }]
}
