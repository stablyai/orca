// Which owner comment answered each question line of an agent's ask. A quick reply names its line by
// its words, and one comment can name several lines ("Question → answer" each); a typed reply answers the line the comment box was "Replying to", the first one still open;
// an answer a v1.4.265 host recorded answers every line it holds. The host links only the first reply
// to its question (that reply moves the item to In progress), so the pairing is read from the order of
// events: the owner's comments after each ask, until its lines are answered, the item closes, or the
// item leaves Needs you without an answer. A later question leaves an earlier ask's open lines open.
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

/** A move that no answer made, to anything but Needs you (a close, or the owner's or agent's own
 *  move), ends every ask's wait; an answer's move does not, so an ask asked before another keeps its
 *  open lines. */
function endsAsks(event: BotItemEvent): boolean {
  return (
    isClose(event) ||
    (event.kind === 'status' && event.data.to !== 'needs_you' && event.data.cause !== 'answer')
  )
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

type OpenAsk = { id: string; entry: BotItemQuestionAnswers }

/** The open asks' lines a reply answers: a recorded answer, a quick reply's words or a comment naming no
 *  line go to the ask it names (the one waiting when it was sent), or the oldest open one when it names
 *  none open; "Question → answer" lines go to the first ask asking that question, the named one first. */
function answeredLines(
  open: readonly OpenAsk[],
  reply: BotItemEvent,
  asked: ReadonlySet<string>
): { ask: OpenAsk; lines: number[]; byOrder: boolean }[] {
  const named = open.find(({ id }) => id === reply.data.answers)
  const asks = named ? [named, ...open.filter((ask) => ask !== named)] : open
  // Words that name no question answer only the ask the reply names, else the oldest open one.
  const own = named ? [named] : open
  const recorded = named && recordedLines(reply.data, named.entry.shape.decisions.length)
  if (named && recorded) {
    return [{ ask: named, lines: recorded, byOrder: false }]
  }
  // Sent as a comment of its own, with no question named in the box.
  if (reply.data.plain === true) {
    return []
  }
  const text = typeof reply.data.text === 'string' ? reply.data.text.trim() : ''
  // A line read by order is open to a comment that names it.
  const isOpen = ({ answers, byOrder }: BotItemQuestionAnswers, index: number): boolean =>
    !answers[index] || byOrder[index] === true
  for (const ask of own) {
    const { shape } = ask.entry
    const picked = shape.decisions.findIndex(
      (decision, index) =>
        isOpen(ask.entry, index) &&
        decision.replies.some((option) => botItemQuickReplyText(shape, decision, option) === text)
    )
    if (picked !== -1) {
      return [{ ask, lines: [picked], byOrder: false }]
    }
  }
  // Several questions answered in one comment, a line each; or a quick reply edited before sending.
  // They belong to one ask: the one it names first, so a question asked again in a later ask keeps
  // its own line open.
  for (const ask of asks) {
    const lines = botItemNamedAnswers(ask.entry.shape, text).flatMap((words, index) =>
      words !== null && isOpen(ask.entry, index) ? [index] : []
    )
    if (lines.length > 0) {
      return [{ ask, lines, byOrder: false }]
    }
  }
  if (answersAskedQuestions(text, asked)) {
    return []
  }
  for (const ask of own) {
    const next = ask.entry.answers.indexOf(null)
    if (next !== -1) {
      return [{ ask, lines: [next], byOrder: true }]
    }
  }
  return []
}

export function botItemQuestionPairing(
  item: Pick<BotItem, 'status' | 'waitingAsk'>,
  events: readonly BotItemEvent[]
): BotItemQuestionPairing {
  const questions = new Map<string, BotItemQuestionAnswers>()
  const replies = new Map<string, { questionId: string; decision: BotItemDecision }>()
  // Asks with lines still open, oldest first: a later question leaves an earlier one open.
  let open: OpenAsk[] = []
  // Every question line asked on the item so far.
  const asked = new Set<string>()
  for (const event of events) {
    if (endsAsks(event)) {
      open = []
      continue
    }
    if (event.kind === 'status' && event.data.cause === 'answer') {
      // An answer moved the item on: an ask it left with no open line takes no later reply.
      open = open.filter(({ entry }) => entry.answers.includes(null))
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
        open.push({ id: event.id, entry })
      }
      continue
    }
    for (const { ask, lines, byOrder: guessed } of answeredLines(open, event, asked)) {
      const { shape, answers, byOrder } = ask.entry
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
        replies.set(event.id, { questionId: ask.id, decision: shape.decisions[quoted]! })
      }
    }
  }
  // One ask waits at a time, the oldest with a line open, so each answer has one question to go to.
  // The host names it; while it is still on an earlier page, none waits.
  const waiting = open.find(({ entry }) => entry.answers.includes(null))
  const unread = item.waitingAsk !== undefined && !questions.has(item.waitingAsk)
  if (waiting && !unread && item.status !== 'done' && item.status !== 'canceled') {
    waiting.entry.waiting = true
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

/** The ask the agent waits on, by its event id, with its lines' answers so far. */
export function botItemWaitingAsk(
  item: Pick<BotItem, 'status' | 'waitingAsk'>,
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

/** What the comment box replies to while the agent waits: the first open line of its ask, with
 *  `replies` when that line has quick replies. The item's own question stands in until its event is
 *  read. A Needs you comment that asks no question has nothing to reply to. */
export function botItemWaitingLine(
  item: Pick<BotItem, 'question' | 'status' | 'waitingAsk'>,
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
  // Another ask waits, still on an earlier page: the item's own question doesn't stand in for it.
  if (item.waitingAsk !== undefined && item.waitingAsk !== question.eventId) {
    return null
  }
  // Read, its ask has no open line, or it asks nothing: no reply target.
  const decision = events.some((event) => event.id === question.eventId)
    ? undefined
    : question.decisions?.[0]
  return decision
    ? {
        id: question.eventId,
        eventId: question.eventId,
        line: botItemQuestionLine(decision.question),
        replies: decision.replies.length > 0
      }
    : null
}
