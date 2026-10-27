import type { AgentJournalFreeTextInput, AgentJournalQuestion } from './agent-session-journal-types'
import type { AgentSessionQuestionAnswer } from './agent-session-question-answer'
import type { AskAnswerSelection } from './native-chat-ask-answer'
import type { AskPrompt } from './native-chat-ask-types'
import { askTypedText } from './native-chat-ask-card-rules'

/** A structured prompt drawn with the same stepped card as a terminal ask. */
type StructuredQuestionCard = {
  prompt: AskPrompt
  allowOther: boolean[]
  freeTextInputs: (AgentJournalFreeTextInput | undefined)[]
}

export function structuredQuestionCard(
  questions: readonly AgentJournalQuestion[]
): StructuredQuestionCard {
  return {
    prompt: {
      questions: questions.map((question) => ({
        question: question.question,
        ...(question.header ? { header: question.header } : {}),
        multiSelect: question.multiSelect,
        options: question.options.map((option) => ({
          label: option.label,
          ...(option.description ? { description: option.description } : {})
        }))
      }))
    },
    allowOther: questions.map((question) => Boolean(question.freeTextQuestionId)),
    freeTextInputs: questions.map((question) => question.freeTextInput)
  }
}

/** Null until every question has an answer, because hosts refuse a partial set. */
export function structuredQuestionAnswers(
  questions: readonly AgentJournalQuestion[],
  selections: readonly AskAnswerSelection[]
): AgentSessionQuestionAnswer[] | null {
  const answers = questions.map((question, index) => {
    const selection = selections[index]
    const other =
      selection?.other === undefined
        ? undefined
        : askTypedText(selection.other, question.freeTextInput)
    return {
      questionId: question.id,
      optionIds: (selection?.indices ?? []).flatMap((optionIndex) => {
        const id = question.options[optionIndex]?.id
        return id ? [id] : []
      }),
      ...(other !== undefined && (other.length > 0 || question.freeTextInput?.allowEmpty)
        ? { other }
        : {})
    }
  })
  return answers.every((answer) => answer.optionIds.length > 0 || answer.other !== undefined)
    ? answers
    : null
}
