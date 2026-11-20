// Which owner comment answered each question line of an agent's ask. A quick reply names its line by
// its words; a typed reply answers the line the comment box was "Replying to", the first one still open;
// an answer a v1.4.265 host recorded answers every line it holds. The host links only the first reply
// to its question (that reply moves the item to In progress), so the pairing is read from the order of
// events: the owner's comments after the ask, up to the agent's next question or the item's close.
import {
  botItemQuestionLine,
  botItemQuestionShape,
  botItemQuickReplyText,
  type BotItemDecision,
  type BotItemQuestionShape
} from './bot-item-ask'
import type { BotItem, BotItemEvent } from './bot-items'

export type BotItemQuestionAnswers = {
  shape: BotItemQuestionShape
  /** Per question line, the owner comment that answered it. */
  answers: (BotItemEvent | null)[]
  /** Lines still open, and the agent still waiting on them. */
  waiting: boolean
}

export type BotItemQuestionPairing = {
  /** By the ask's event id. */
  questions: Map<string, BotItemQuestionAnswers>
  /** By the owner comment's event id: the ask and the line it answered. */
  replies: Map<string, { questionId: string; decision: BotItemDecision }>
}

function isClose(event: BotItemEvent): boolean {
  return event.kind === 'status' && (event.data.to === 'done' || event.data.to === 'canceled')
}

/** The agent asking again ends the earlier ask's window. */
function isNewQuestion(event: BotItemEvent): boolean {
  return event.actor.kind !== 'owner' && event.kind === 'status' && event.data.to === 'needs_you'
}

/** The lines a recorded answer covers: each decision it holds a pick or words for. */
function recordedLines(data: Record<string, unknown>, count: number): number[] | null {
  if (!Array.isArray(data.decisions)) {
    return null
  }
  const decisions: unknown[] = data.decisions
  return Array.from({ length: count }, (_, index) => index).filter((index) => {
    const decision = decisions[index]
    return typeof decision === 'object' && decision !== null
  })
}

function answeredLines(
  shape: BotItemQuestionShape,
  answers: readonly (BotItemEvent | null)[],
  reply: BotItemEvent
): number[] {
  const recorded = recordedLines(reply.data, shape.decisions.length)
  if (recorded) {
    return recorded
  }
  const text = typeof reply.data.text === 'string' ? reply.data.text.trim() : ''
  const open = (index: number): boolean => !answers[index]
  const picked = shape.decisions.findIndex(
    (decision, index) =>
      open(index) &&
      decision.replies.some((option) => botItemQuickReplyText(shape, decision, option) === text)
  )
  // A quick reply of several questions, edited before sending, still names its question.
  const named =
    picked === -1 && shape.decisions.length > 1
      ? shape.decisions.findIndex(
          (decision, index) =>
            open(index) && text.startsWith(`${botItemQuestionLine(decision.question)} →`)
        )
      : picked
  if (named !== -1) {
    return [named]
  }
  const next = answers.indexOf(null)
  return next === -1 ? [] : [next]
}

export function botItemQuestionPairing(
  item: Pick<BotItem, 'question' | 'status'>,
  events: readonly BotItemEvent[]
): BotItemQuestionPairing {
  const questions = new Map<string, BotItemQuestionAnswers>()
  const replies = new Map<string, { questionId: string; decision: BotItemDecision }>()
  let current: { id: string; entry: BotItemQuestionAnswers } | null = null
  for (const event of events) {
    if (isClose(event) || isNewQuestion(event)) {
      // An ask's own Needs you move comes right after it, in the same write: its window stays open.
      if (current && !(isNewQuestion(event) && current.id === lastAsk(events, event)?.id)) {
        current = null
      }
      continue
    }
    if (event.kind !== 'commented') {
      continue
    }
    if (event.actor.kind !== 'owner') {
      const shape = botItemQuestionShape(event.data)
      if (shape.decisions.length > 0) {
        const entry: BotItemQuestionAnswers = {
          shape,
          answers: shape.decisions.map(() => null),
          waiting: false
        }
        questions.set(event.id, entry)
        current = { id: event.id, entry }
      }
      continue
    }
    if (!current) {
      continue
    }
    const { shape, answers } = current.entry
    const lines = answeredLines(shape, answers, event)
    for (const line of lines) {
      if (answers[line] === null) {
        answers[line] = event
      }
    }
    // It quotes the first line it answers.
    const first = lines[0]
    if (first !== undefined) {
      replies.set(event.id, { questionId: current.id, decision: shape.decisions[first]! })
    }
  }
  if (current) {
    const { entry } = current
    const open = entry.answers.some((answer) => answer === null)
    const started = entry.answers.some((answer) => answer !== null)
    // Asked and waiting, or part answered: once one line is answered the item is In progress again.
    entry.waiting =
      open &&
      item.status !== 'done' &&
      item.status !== 'canceled' &&
      (item.question?.eventId === current.id || started)
  }
  return { questions, replies }
}

/** The agent comment that came with this Needs you move: the last comment before it in its write. */
function lastAsk(events: readonly BotItemEvent[], move: BotItemEvent): BotItemEvent | undefined {
  const at = events.indexOf(move)
  for (let index = at - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.kind === 'commented') {
      return event.at === move.at ? event : undefined
    }
  }
  return undefined
}

/** What the comment box replies to while the agent waits: the first open line of its ask, else its
 *  question asked in prose, by its first line; with `replies` when that line has quick replies. The
 *  item's own question stands in until its event is read. */
export function botItemWaitingLine(
  item: Pick<BotItem, 'question' | 'status'>,
  events: readonly BotItemEvent[]
): { id: string; line: string; replies: boolean } | null {
  for (const [questionId, entry] of botItemQuestionPairing(item, events).questions) {
    const index = entry.answers.indexOf(null)
    const decision = entry.shape.decisions[index]
    if (entry.waiting && decision) {
      return {
        id: `${questionId}:${index}`,
        line: botItemQuestionLine(decision.question),
        replies: decision.replies.length > 0
      }
    }
  }
  const { question } = item
  if (item.status !== 'needs_you' || !question) {
    return null
  }
  const asked = events.find((event) => event.id === question.eventId)
  if (asked && botItemQuestionShape(asked.data).decisions.length > 0) {
    // Its ask is read and has no open line.
    return null
  }
  const decision = asked ? undefined : question.decisions?.[0]
  return {
    id: question.eventId,
    line: botItemQuestionLine(decision?.question ?? question.gist ?? question.text),
    replies: (decision?.replies.length ?? 0) > 0
  }
}
