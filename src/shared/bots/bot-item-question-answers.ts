// Which owner comment answered each question line of an agent's ask. A quick reply names its line by
// its words, and one comment can name several lines ("Question → answer" each); a typed reply answers the line the comment box was "Replying to", the first one still open;
// an answer a v1.4.265 host recorded answers every line it holds. The host links only the first reply
// to its question (that reply moves the item to In progress), so the pairing is read from the order of
// events: the owner's comments after each ask, until its lines are answered, the item closes, or the
// item leaves Needs you without an answer. A later ask replaces an earlier one's open lines, and an
// answer sent with the rest skipped ("send anyway") closes its ask's.
import { botItemNamedAnswers } from './bot-item-answer-lines'
import {
  botItemIsQuickReplyText,
  botItemQuestionLeads,
  botItemQuestionLine,
  botItemQuestionShape,
  type BotItemDecision,
  type BotItemQuestionShape
} from './bot-item-ask'
import { parseBotItemEventId, type BotItem, type BotItemEvent } from './bot-items'
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
  /** Why its open lines take no answer: a later ask came, or the owner sent answers skipping them. */
  ended: BotItemAskEnd | null
}

export type BotItemAskEnd = 'replaced' | 'skipped'

/** The end an ask's card names: while a line no comment or send answered stays open to nothing, even
 *  one showing an answer held on this device, which only goes back to the box. */
export function botItemShownAskEnd(
  ended: BotItemAskEnd | null,
  answered: readonly (string | null)[]
): BotItemAskEnd | null {
  return ended && answered.some((words) => !words) ? ended : null
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
 *  move), ends the ask's wait; an answer's move does not, so the ask keeps its other open lines. */
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

/** The open ask's lines a reply answers. A reply naming any other event (an ask this replaced, even
 *  one on an earlier page) answers none. */
function answeredLines(
  open: OpenAsk,
  reply: BotItemEvent,
  asked: ReadonlySet<string>
): { lines: number[]; byOrder: boolean } {
  const none = { lines: [], byOrder: false }
  const names = typeof reply.data.answers === 'string' ? reply.data.answers : undefined
  if (names !== undefined && names !== open.id) {
    return none
  }
  const { shape, answers, byOrder } = open.entry
  const recorded = names === open.id && recordedLines(reply.data, shape.decisions.length)
  if (recorded) {
    return { lines: recorded, byOrder: false }
  }
  // Sent as a comment of its own, with no question named in the box.
  if (reply.data.plain === true) {
    return none
  }
  const text = typeof reply.data.text === 'string' ? reply.data.text.trim() : ''
  // A line read by order is open to a comment that names it.
  const isOpen = (index: number): boolean => !answers[index] || byOrder[index] === true
  const picked = shape.decisions.findIndex(
    (decision, index) =>
      isOpen(index) &&
      decision.replies.some((option) => botItemIsQuickReplyText(shape, index, option, text))
  )
  if (picked !== -1) {
    return { lines: [picked], byOrder: false }
  }
  // Several questions answered in one comment, a line each; or a quick reply edited before sending.
  const wordsByLine = botItemNamedAnswers(shape, text)
  const named = wordsByLine.flatMap((words, index) =>
    words !== null && isOpen(index) ? [index] : []
  )
  if (named.length > 0) {
    return { lines: named, byOrder: false }
  }
  // If the named lines were answered meanwhile, a late reply can't take another line by order.
  if (wordsByLine.some((words) => words !== null) || answersAskedQuestions(text, asked)) {
    return none
  }
  const next = answers.indexOf(null)
  return next === -1 ? none : { lines: [next], byOrder: true }
}

// Hosts keep the waiting ask this pairs: a change to what it pairs bumps WAITING_ASK_RULES
// (src/main/bots/bot-item-waiting-ask-keep.ts), and one to what events can't change it updates waitingAskChange there.
export function botItemQuestionPairing(
  item: Pick<BotItem, 'status'>,
  events: readonly BotItemEvent[]
): BotItemQuestionPairing {
  const questions = new Map<string, BotItemQuestionAnswers>()
  const replies = new Map<string, { questionId: string; decision: BotItemDecision }>()
  // The latest ask, while a line of it is still open.
  let open: OpenAsk | null = null
  // Every question line asked on the item so far.
  const asked = new Set<string>()
  for (const event of events) {
    if (endsAsks(event)) {
      open = null
      continue
    }
    if (event.kind === 'status' && event.data.cause === 'answer') {
      // An answer moved the item on: an ask it left with no open line takes no later reply.
      if (open && !open.entry.answers.includes(null)) {
        open = null
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
          waiting: false,
          ended: null
        }
        questions.set(event.id, entry)
        for (const decision of shape.decisions) {
          for (const lead of botItemQuestionLeads(decision.question)) {
            asked.add(lead)
          }
        }
        if (open?.entry.answers.includes(null)) {
          // A new ask replaces the earlier one's open lines; its answers so far stand.
          open.entry.ended = 'replaced'
        }
        open = { id: event.id, entry }
      }
      continue
    }
    if (!open) {
      continue
    }
    const { shape, answers, byOrder } = open.entry
    const { lines, byOrder: guessed } = answeredLines(open, event, asked)
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
      replies.set(event.id, { questionId: open.id, decision: shape.decisions[quoted]! })
    }
    if (skipsRest(open, event)) {
      if (answers.includes(null)) {
        open.entry.ended = 'skipped'
      }
      open = null
    }
  }
  // Only the latest ask waits, so each answer has one question to go to.
  if (open?.entry.answers.includes(null) && item.status !== 'done' && item.status !== 'canceled') {
    open.entry.waiting = true
  }
  return { questions, replies }
}

/** An answer sent with the ask's other lines skipped: the host lists them in `skipped`. */
function skipsRest(open: OpenAsk, reply: BotItemEvent): boolean {
  return (
    reply.data.answers === open.id &&
    Array.isArray(reply.data.skipped) &&
    reply.data.skipped.length > 0
  )
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

/** The ask the host's item read says waits: its `waitingAsk`, else its Needs you question. */
/** The ask the host's read says the agent waits on, whatever events are loaded; null when it names none. */
export function botItemHostWaitingAsk(item: BotItemWaitingView): string | null {
  return item.waitingAsk ?? (item.status === 'needs_you' ? (item.question?.eventId ?? null) : null)
}

/** An item as a client reads it: the host's own waiting ask and question, where it sent them. */
type BotItemWaitingView = Pick<BotItem, 'status'> &
  Partial<Pick<BotItem, 'question' | 'waitingAsk'>>

/** The ask the agent waits on, by its event id, with its lines' answers so far. When the host's read
 *  names a newer ask than the loaded events pair (a replaced question still on screen), the host's
 *  wins: its own entry when loaded, else none, so the box falls back to the host's question. Replies
 *  then name the ask the host waits on, and one meant for another is refused, never moved to it. */
export function botItemWaitingAsk(
  item: BotItemWaitingView,
  events: readonly BotItemEvent[]
): ({ askId: string } & BotItemQuestionAnswers) | null {
  const { questions } = botItemQuestionPairing(item, events)
  const paired = [...questions].find(([, entry]) => entry.waiting)
  if (!paired) {
    return null
  }
  const host = botItemHostWaitingAsk(item)
  if (
    host === null ||
    host === paired[0] ||
    (parseBotItemEventId(host) ?? 0) <= (parseBotItemEventId(paired[0]) ?? 0)
  ) {
    return { askId: paired[0], ...paired[1] }
  }
  const own = questions.get(host)
  return own ? { askId: host, ...own, waiting: true } : null
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
  const waiting = botItemWaitingAsk(item, events)
  const open = waiting?.answers.indexOf(null) ?? -1
  const line = waiting?.shape.decisions[open]
  if (waiting && line) {
    return {
      id: `${waiting.askId}:${open}`,
      eventId: waiting.askId,
      line: botItemQuestionLine(line.question),
      replies: line.replies.length > 0
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
