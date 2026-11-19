// A prompt whose agent process ended before anyone answered (Orca quit, update or crash). Its card
// stays answerable: answering resumes the chat, and the resumed agent's identical request takes it.

import type {
  AgentJournalApprovalItem,
  AgentJournalPromptIntent,
  AgentJournalQuestionItem,
  AgentJournalRenderItem
} from '../../journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../lifecycle/records/agent-session-turn-record'

export const AGENT_EXIT_PROMPT_ENDING = 'agent_exit'

type PromptBody = AgentJournalApprovalItem | AgentJournalQuestionItem
export type RestoredAgentJournalPrompt = AgentJournalRenderItem & { body: PromptBody }

/** Cancelled only because its agent exited, and written by a build that can match it again. */
export function isAgentExitPromptBody(body: AgentJournalRenderItem['body']): body is PromptBody {
  return (
    (body.kind === 'approval' || body.kind === 'question') &&
    body.resolution.state === 'cancelled' &&
    body.resolution.endedBy === AGENT_EXIT_PROMPT_ENDING &&
    typeof body.requestDigest === 'string'
  )
}

/** The chat's last prompt, when its agent exited waiting on it and nothing has happened since.
 *  Callers also require that no agent is running for the chat. */
export function restoredAgentJournalPrompt(
  items: readonly AgentJournalRenderItem[]
): RestoredAgentJournalPrompt | null {
  const index = items.findLastIndex(
    (item) => item.body.kind === 'approval' || item.body.kind === 'question'
  )
  const item = items[index]
  if (!item || !isAgentExitPromptBody(item.body)) {
    return null
  }
  const turnItemId = item.turnScope?.kind === 'turn' ? item.turnScope.turnItemId : null
  // Two waiting in one turn (grouped questions, parallel calls) can't be told apart on resume.
  const previous = items.findLast(
    (other, at) => at < index && (other.body.kind === 'approval' || other.body.kind === 'question')
  )
  if (
    previous &&
    isAgentExitPromptBody(previous.body) &&
    previous.turnScope?.kind === 'turn' &&
    previous.turnScope.turnItemId === turnItemId
  ) {
    return null
  }
  for (const later of items.slice(index + 1)) {
    // A send or another turn after the prompt means the chat moved on.
    if (
      (later.body.kind === 'message' && later.body.role === 'user') ||
      (readAgentJournalTurn(later.body) !== null && later.itemId !== turnItemId)
    ) {
      return null
    }
  }
  return { ...item, body: item.body }
}

/** The re-asked request's option with the chosen option's meaning; ids can differ between asks. */
export function restoredPromptOptionFor(
  restored: Pick<AgentJournalApprovalItem, 'options'>,
  selectedOptionId: string,
  live: Pick<AgentJournalApprovalItem, 'options'>
): string | null {
  const intent: AgentJournalPromptIntent | undefined = restored.options.find(
    (option) => option.id === selectedOptionId
  )?.intent
  if (!intent) {
    return null
  }
  return live.options.find((option) => option.intent === intent)?.id ?? null
}

const MESSAGE_DETAIL_CHARS = 600

function clip(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > MESSAGE_DETAIL_CHARS
    ? `${trimmed.slice(0, MESSAGE_DETAIL_CHARS - 1)}…`
    : trimmed
}

/** The labels the person picked, for the message that tells the resumed agent their answer. */
function answerWords(
  body: AgentJournalQuestionItem,
  answers: readonly { questionId: string; optionIds: string[]; other?: string }[]
): string {
  const questions = body.questions ?? [
    { id: body.freeTextQuestionId ?? '', question: body.question, options: body.options }
  ]
  return answers
    .map((answer) => {
      const question = questions.find((entry) => entry.id === answer.questionId) ?? questions[0]
      const picked = answer.optionIds.map(
        (id) => question?.options.find((option) => option.id === id)?.label ?? id
      )
      // The answer goes over whole: the agent carries on with it and won't ask again.
      const words = [...picked, ...(answer.other ? [answer.other] : [])].join(', ')
      return question ? `"${clip(question.question)}": ${words}` : words
    })
    .join('; ')
}

/** Sent as the resumed agent's next message. Orca answers an identical re-asked request itself. */
export function restoredPromptContinuationMessage(
  body: PromptBody,
  choice:
    | { kind: 'option'; optionId: string }
    | {
        kind: 'answers'
        answers: readonly { questionId: string; optionIds: string[]; other?: string }[]
      }
): string {
  const lead =
    'Your session stopped while you were waiting for the user (Orca restarted or the agent exited), so your request was cut off.'
  if (body.kind === 'question') {
    const answers = choice.kind === 'answers' ? answerWords(body, choice.answers) : ''
    return `${lead} You asked them a question, and they answered ${answers}. Carry on with that answer; if you ask the same question again, Orca answers it for them.`
  }
  const asked = clip([body.displayName ?? body.title, body.detail ?? ''].join('\n'))
  const intent =
    choice.kind === 'option'
      ? body.options.find((option) => option.id === choice.optionId)?.intent
      : undefined
  if (intent === 'reject_once' || intent === 'reject_always') {
    return `${lead} You asked for approval of:\n${asked}\nThe user denied it. Don't make that request again; carry on another way, or say what you need from them.`
  }
  return `${lead} You asked for approval of:\n${asked}\nThe user approved it. Make the same request again, unchanged, and Orca approves it for them; then carry on. If what you need has changed, ask again normally.`
}
