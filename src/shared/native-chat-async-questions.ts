import type { AgentJournalRenderItem } from './agent-session-journal-types'
import type { AskAnswerSelection, AskPrompt } from './native-chat-ask'
import type { NativeChatAsyncQuestion } from './native-chat-types'

export type PendingAsyncQuestionGroup = {
  key: string
  questions: NativeChatAsyncQuestion[]
  omittedCount?: number
}

export type NativeChatAsyncQuestionReply = {
  pendingQuestions?: PendingAsyncQuestionGroup[]
  disabled: boolean
  send: (text: string) => boolean | Promise<boolean>
}

/** Adapts async choices for the existing question wizard; callers provide free-text Other. */
export function asyncQuestionsPrompt(questions: NativeChatAsyncQuestion[]): AskPrompt {
  return {
    questions: questions.map(({ title, options }) => ({
      question: title,
      multiSelect: false,
      options: options.map((label) => ({ label }))
    }))
  }
}

/** Pairs each answer with its question, preferring typed text and omitting unanswered questions. */
export function formatAsyncQuestionAnswer(
  questions: NativeChatAsyncQuestion[],
  selections: AskAnswerSelection[]
): string {
  const text = questions
    .flatMap((question, index) => {
      const selection = selections[index]
      const answer =
        selection?.other?.trim() ||
        selection?.indices
          .map((choice) => question.options[choice])
          .filter(Boolean)
          .join(', ')
      return answer ? [`${question.title}\n${answer}`] : []
    })
    .join('\n\n')
  // A question title must never turn its answer into a slash command.
  return text.trimStart().startsWith('/') ? `Question: ${text}` : text
}

/** Only assistant messages carrying validated async metadata belong in the pending set. */
export function isAsyncQuestionJournalItem(item: AgentJournalRenderItem): boolean {
  return (
    item.body.kind === 'message' &&
    item.body.role === 'assistant' &&
    item.body.blocks.some((block) => block.type === 'text' && !!block.asyncQuestions?.length)
  )
}

const pendingGroups = new WeakMap<readonly AgentJournalRenderItem[], PendingAsyncQuestionGroup[]>()
const EMPTY_PENDING_GROUPS: PendingAsyncQuestionGroup[] = []

/** Undefined keeps the inline-card fallback for hosts that do not publish async requests. */
export function selectPendingAsyncQuestionGroups(state: {
  currentRequests?: readonly AgentJournalRenderItem[]
  requestAuthority?: { includesAsyncQuestions?: true }
  requestMarker?: { includesAsyncQuestions?: true }
}): { key: string; questions: NativeChatAsyncQuestion[] }[] | undefined {
  if (
    !state.requestAuthority?.includesAsyncQuestions &&
    !state.requestMarker?.includesAsyncQuestions
  ) {
    return undefined
  }
  if (!state.currentRequests) {
    return EMPTY_PENDING_GROUPS
  }
  const previous = pendingGroups.get(state.currentRequests)
  if (previous) {
    return previous
  }
  const groups = state.currentRequests.flatMap((item) =>
    item.body.kind === 'message'
      ? item.body.blocks.flatMap((block, index) =>
          block.type === 'text' && block.asyncQuestions?.length
            ? [{ key: `${item.itemId}:${index}`, questions: block.asyncQuestions }]
            : []
        )
      : []
  )
  pendingGroups.set(state.currentRequests, groups)
  return groups
}
