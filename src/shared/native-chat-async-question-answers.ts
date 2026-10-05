// Client-side answer state for the async question card, shared by desktop and phone.
// Only the host's published set says a question was answered; nothing here hides one.

import {
  formatAsyncQuestionReply,
  type NativeChatAsyncQuestion,
  type NativeChatAsyncQuestionsView
} from './native-chat-async-questions'

/** One question's in-progress answer: a picked option and/or typed text (typed text wins). */
export type NativeChatAsyncQuestionEdit = { option?: string; text?: string }

export type NativeChatAsyncQuestionEdits = Readonly<Record<string, NativeChatAsyncQuestionEdit>>

/** How one Send ended. `withdrawn`: taken back before dispatch (e.g. Stop), so not delivered. */
export type NativeChatAsyncAnswerOutcome =
  | 'accepted'
  | 'queued'
  | 'rejected'
  | 'unknown'
  | 'withdrawn'

export function nativeChatAsyncQuestionAnswer(
  edit: NativeChatAsyncQuestionEdit | undefined
): string | null {
  const text = edit?.text?.trim() ?? ''
  if (text) {
    return text
  }
  return edit?.option ?? null
}

/** A question's options with React keys: a label repeated by the model gets its own key. */
export function nativeChatAsyncQuestionKeyedOptions(
  options: readonly string[]
): { key: string; option: string }[] {
  const seen = new Map<string, number>()
  return options.map((option) => {
    const occurrence = seen.get(option) ?? 0
    seen.set(option, occurrence + 1)
    return { key: `${occurrence}:${option}`, option }
  })
}

/** Questions the card offers: the published ones this device has not dismissed. */
export function nativeChatAsyncQuestionsOpen(
  questions: readonly NativeChatAsyncQuestion[],
  dismissed: ReadonlySet<string>
): NativeChatAsyncQuestion[] {
  return questions.filter((question) => !dismissed.has(question.key))
}

/** Send needs an answer for every question still open on the card. */
export function nativeChatAsyncQuestionsSendable(
  open: readonly NativeChatAsyncQuestion[],
  edits: NativeChatAsyncQuestionEdits
): boolean {
  return (
    open.length > 0 &&
    open.every((question) => nativeChatAsyncQuestionAnswer(edits[question.key]) !== null)
  )
}

/** The reply text and the answers it carries, keyed by question, or null when not sendable. */
export function buildNativeChatAsyncQuestionReply(
  open: readonly NativeChatAsyncQuestion[],
  edits: NativeChatAsyncQuestionEdits
): { text: string; answers: Record<string, string> } | null {
  if (!nativeChatAsyncQuestionsSendable(open, edits)) {
    return null
  }
  const answers: Record<string, string> = {}
  const groups = open.map((question) => {
    const answer = nativeChatAsyncQuestionAnswer(edits[question.key]) ?? ''
    answers[question.key] = answer
    return { title: question.title, answer }
  })
  return { text: formatAsyncQuestionReply(groups), answers }
}

/** Only an authoritative (`ready`) set retires per-key state; `pending`/`absent` keep it. */
export function pruneNativeChatAsyncQuestionKeys<T>(
  view: NativeChatAsyncQuestionsView,
  state: Readonly<Record<string, T>>
): Readonly<Record<string, T>> {
  if (view.state !== 'ready' || view.omittedCount) {
    return state
  }
  const live = new Set(view.questions.map((question) => question.key))
  const kept = Object.entries(state).filter(([key]) => live.has(key))
  return kept.length === Object.keys(state).length ? state : Object.fromEntries(kept)
}

/** A delivered (or host-held) answer is done; anything else keeps the edits to send again. */
export function nativeChatAsyncAnswerDelivered(outcome: NativeChatAsyncAnswerOutcome): boolean {
  return outcome === 'accepted' || outcome === 'queued'
}

/** Restores sent answers as edits: an option's own label comes back as that option. */
export function nativeChatAsyncQuestionEditsFromAnswers(
  questions: readonly NativeChatAsyncQuestion[],
  answers: Readonly<Record<string, string>>
): Record<string, NativeChatAsyncQuestionEdit> {
  const byKey = new Map(questions.map((question) => [question.key, question]))
  return Object.fromEntries(
    Object.entries(answers).map(([key, answer]) => [
      key,
      byKey.get(key)?.options?.includes(answer) ? { option: answer } : { text: answer }
    ])
  )
}
