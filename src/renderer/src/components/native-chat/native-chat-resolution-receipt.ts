import type {
  AgentJournalApprovalItem,
  AgentJournalQuestionItem
} from '../../../../shared/agent-session-journal-types'
import {
  agentSessionPromptQuestions,
  legacyAgentSessionQuestionAnswers
} from '../../../../shared/agent-session-question-answer'

export type NativeChatResolvedPrompt = AgentJournalApprovalItem | AgentJournalQuestionItem
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
      return {
        question: body.questions ? question.question : null,
        answer: valid
          ? [...(labels ?? []), ...(answer?.other ? [answer.other] : [])].join(' · ') || null
          : null
      }
    })
  }
  const option = body.options.find((option) => option.id === selected)
  return [{ question: null, answer: option?.label ?? null }]
}
