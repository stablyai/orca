// Which owner comment answered each question line of an agent's ask. A quick reply names its line by
// its words, and one comment can name several lines ("Question → answer" each); a typed reply answers the line the comment box was "Replying to", the first one still open;
// an answer a v1.4.265 host recorded answers every line it holds. The host links only the first reply
// to its question (that reply moves the item to In progress), so the pairing is read from the order of
// events: the owner's comments after the ask, up to the agent's next question or the item's close.
import { botItemNamedAnswers } from './bot-item-answer-lines'
import {
  botItemQuestionLine,
  botItemQuestionShape,
  botItemQuickReplyText,
  type BotItemDecision,
  type BotItemQuestionShape
} from './bot-item-ask'
import type { BotItem, BotItemEvent } from './bot-items'
import { IMAGE_PROMPT_MARKER } from '../native-chat/transcript/images/native-chat-sent-image-prompt-markers'

export type BotItemQuestionAnswers = {
  shape: BotItemQuestionShape
  /** Per question line, the owner comment that answered it. */
  answers: (BotItemEvent | null)[]
  /** Per line, answered only by order: a comment naming no line took the first open one. A later
   *  comment naming the line takes it over. */
  byOrder: boolean[]
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

/** Every line answers a question the item's asks asked ("Question → answer"): such a comment never
 *  answers a line by order (answers held for an earlier ask, sent after the agent asked again). */
function answersAskedQuestions(text: string, asked: ReadonlySet<string>): boolean {
  const lines = text.split('\n').filter((line) => line.trim())
  return (
    lines.length > 0 &&
    lines.every((line) => [...asked].some((question) => line.trim().startsWith(`${question} →`)))
  )
}

function answeredLines(
  entry: BotItemQuestionAnswers,
  reply: BotItemEvent,
  asked: ReadonlySet<string>
): { lines: number[]; byOrder: boolean } {
  const { shape, answers, byOrder } = entry
  const recorded = recordedLines(reply.data, shape.decisions.length)
  if (recorded) {
    return { lines: recorded, byOrder: false }
  }
  // Sent as a comment of its own, with no question named in the box.
  if (reply.data.plain === true) {
    return { lines: [], byOrder: false }
  }
  const text = typeof reply.data.text === 'string' ? reply.data.text.trim() : ''
  // A line read by order is open to a comment that names it.
  const open = (index: number): boolean => !answers[index] || byOrder[index] === true
  const picked = shape.decisions.findIndex(
    (decision, index) =>
      open(index) &&
      decision.replies.some((option) => botItemQuickReplyText(shape, decision, option) === text)
  )
  if (picked !== -1) {
    return { lines: [picked], byOrder: false }
  }
  // Several questions answered in one comment, a line each; or a quick reply edited before sending.
  const named = botItemNamedAnswers(shape, text).flatMap((words, index) =>
    words !== null && open(index) ? [index] : []
  )
  if (named.length > 0) {
    return { lines: named, byOrder: false }
  }
  if (answersAskedQuestions(text, asked)) {
    return { lines: [], byOrder: false }
  }
  const next = answers.indexOf(null)
  return { lines: next === -1 ? [] : [next], byOrder: true }
}

export function botItemQuestionPairing(
  item: Pick<BotItem, 'question' | 'status'>,
  events: readonly BotItemEvent[]
): BotItemQuestionPairing {
  const questions = new Map<string, BotItemQuestionAnswers>()
  const replies = new Map<string, { questionId: string; decision: BotItemDecision }>()
  let current: { id: string; entry: BotItemQuestionAnswers } | null = null
  // Every question line asked on the item so far.
  const asked = new Set<string>()
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
          byOrder: shape.decisions.map(() => false),
          waiting: false
        }
        questions.set(event.id, entry)
        for (const decision of shape.decisions) {
          asked.add(botItemQuestionLine(decision.question))
        }
        current = { id: event.id, entry }
      }
      continue
    }
    if (!current) {
      continue
    }
    const { shape, answers, byOrder } = current.entry
    const { lines, byOrder: guessed } = answeredLines(current.entry, event, asked)
    for (const line of lines) {
      const taken = answers[line]
      if (taken && byOrder[line]) {
        // Named now: the comment read by order is a comment of its own again.
        replies.delete(taken.id)
      } else if (taken) {
        continue
      }
      answers[line] = event
      byOrder[line] = guessed
    }
    const quoted = quotedLine(shape, event, lines)
    if (quoted !== undefined) {
      replies.set(event.id, { questionId: current.id, decision: shape.decisions[quoted]! })
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

/** The line a reply quotes: the one its image is on, else the last it answers (answers held for
 *  earlier lines post ahead of the one just given). */
function quotedLine(
  shape: BotItemQuestionShape,
  reply: BotItemEvent,
  lines: readonly number[]
): number | undefined {
  const named = botItemNamedAnswers(
    shape,
    typeof reply.data.text === 'string' ? reply.data.text : ''
  )
  return lines.find((line) => IMAGE_PROMPT_MARKER.test(named[line] ?? '')) ?? lines.at(-1)
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

/** The ask the agent waits on, by its event id, with its lines' answers so far. */
export function botItemWaitingAsk(
  item: Pick<BotItem, 'question' | 'status'>,
  events: readonly BotItemEvent[]
): ({ askId: string } & BotItemQuestionAnswers) | null {
  for (const [askId, entry] of botItemQuestionPairing(item, events).questions) {
    if (entry.waiting) {
      return { askId, ...entry }
    }
  }
  return null
}

/** A line the comment box replies to; `eventId` is the comment that asks it. */
export type BotItemWaitingLine = { id: string; eventId: string; line: string; replies: boolean }

/** What the comment box replies to while the agent waits: the first open line of its ask, else its
 *  question asked in prose, by its first line; with `replies` when that line has quick replies. The
 *  item's own question stands in until its event is read. */
export function botItemWaitingLine(
  item: Pick<BotItem, 'question' | 'status'>,
  events: readonly BotItemEvent[]
): BotItemWaitingLine | null {
  for (const [questionId, entry] of botItemQuestionPairing(item, events).questions) {
    const index = entry.answers.indexOf(null)
    const decision = entry.shape.decisions[index]
    if (entry.waiting && decision) {
      return {
        id: `${questionId}:${index}`,
        eventId: questionId,
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
    eventId: question.eventId,
    line: botItemQuestionLine(decision?.question ?? question.gist ?? question.text),
    replies: (decision?.replies.length ?? 0) > 0
  }
}
