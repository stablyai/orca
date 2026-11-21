// An item's Activity in time order: its own events, plus each linked worker's start and finish read
// from the worker's own record (never stored on the item). A worker's link event is its start.
// A Needs you question and its status move come in one write: the comment carries both.
// The owner's reply quotes the question line it answers (bot-item-question-answers.ts), and an answer to
// several lines of an ask quotes each line above its words; the move the first one caused
// (`cause: 'answer'`) is not shown while the question is loaded. Answers recorded by older hosts are
// replies like any other. Comments still on their way to the host pair as answers too, and come last.
import { botItemCommentFiles } from './bot-item-comment-files'
import { botItemAnswersRest, botItemNamedAnswers } from './bot-item-answer-lines'
import { botItemQuestionLine, type BotItemQuestionShape } from './bot-item-ask'
import {
  botItemLinksOnePerChain,
  type BotItem,
  type BotItemEvent,
  type BotItemLinkView
} from './bot-items'
import { botItemQuestionPairing, type BotItemQuestionPairing } from './bot-item-question-answers'

type DispatchLink = Extract<BotItemLinkView, { kind: 'dispatch' }>

/** An answer to lines of an ask, a line each in the ask's order: the question, then the words, whose
 *  [Image #N] name that line's images; `rest` is the comment's own words besides them. */
export type BotItemAnswered = {
  askId: string
  total: number
  lines: { index: number; question: string; words: string }[]
  rest: string
}

export type BotItemActivityEntry =
  | { kind: 'event'; key: string; at: number; event: BotItemEvent }
  | {
      kind: 'comment'
      key: string
      at: number
      event: BotItemEvent
      /** The agent waits on this question (an ask: on its open lines): its mark and quick replies show. */
      waiting: boolean
      /** On an ask: per question line, the owner comment that answered it. */
      answers?: (BotItemEvent | null)[]
      /** On an ask: per line, answered only by order (a comment naming no line). */
      byOrder?: boolean[]
      /** On the owner's reply to a question: the question it answers, by its first line, and the
       *  ask's line it answers. */
      replyTo?: { eventId: string; text: string; line?: number }
      /** On the owner's answer naming lines of an ask of several questions: each line it answers. */
      answered?: BotItemAnswered
    }
  | { kind: 'worker'; key: string; at: number; phase: 'started' | 'finished'; link: DispatchLink }

/** The question an owner's comment answers (`answers`), or null for any other event. */
function answeredQuestion(event: BotItemEvent): string | null {
  return event.kind === 'commented' &&
    event.actor.kind === 'owner' &&
    typeof event.data.answers === 'string'
    ? event.data.answers
    : null
}

/** An answer naming its lines of an ask of several questions: words and images, no recorded picks
 *  or files, which show on a reply's card as ever. */
function answeredLines(
  event: BotItemEvent,
  pairing: BotItemQuestionPairing
): BotItemAnswered | undefined {
  const text = typeof event.data.text === 'string' ? event.data.text : ''
  const paired = pairing.replies.get(event.id)
  const shape = paired ? pairing.questions.get(paired.questionId)?.shape : undefined
  if (
    !paired ||
    !shape ||
    shape.decisions.length < 2 ||
    paired.byOrder ||
    Array.isArray(event.data.decisions) ||
    botItemCommentFiles(text).files.length > 0
  ) {
    return undefined
  }
  return botItemAnswered(paired.questionId, shape, text, paired.lines)
}

/** `text` as an answer to `lines` of an ask, each named in it ("Question → answer"); undefined where
 *  one is not. */
export function botItemAnswered(
  askId: string,
  shape: BotItemQuestionShape,
  text: string,
  lines: readonly number[]
): BotItemAnswered | undefined {
  const named = botItemNamedAnswers(shape, text)
  const found = [...lines]
    .sort((a, b) => a - b)
    .flatMap((index) => {
      const words = named[index]
      return words
        ? [{ index, question: botItemQuestionLine(shape.decisions[index]!.question), words }]
        : []
    })
  return found.length > 0 && found.length === lines.length
    ? {
        askId,
        total: shape.decisions.length,
        lines: found,
        rest: botItemAnswersRest(shape, text, lines)
      }
    : undefined
}

function linksOnlyWorkers(event: BotItemEvent): boolean {
  const links = Array.isArray(event.data.links) ? event.data.links : []
  return links.length > 0 && links.every((link) => String(link).startsWith('dispatch:'))
}

function asksWith(comment?: BotItemEvent, status?: BotItemEvent): boolean {
  return (
    comment?.kind === 'commented' &&
    status?.kind === 'status' &&
    status.data.to === 'needs_you' &&
    !status.data.note &&
    comment.at === status.at &&
    JSON.stringify(comment.actor) === JSON.stringify(status.actor)
  )
}

/** A snooze ending (or starting) is written between a comment and the move it came with, so pairing
 *  reads past it. */
function isSnoozeMark(event: BotItemEvent): boolean {
  return event.kind === 'snoozed' || event.kind === 'unsnoozed'
}

/** The question's first line, as a reply quotes it: Markdown marks dropped, one line. */
export function botItemQuestionFirstLine(text: string): string {
  const line = text.split('\n').find((part) => part.trim()) ?? ''
  return line
    .replace(/^\s*(?:#+|>|[-*+]|\d+[.)])\s+/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .trim()
}

/** What a reply quotes: the ask's line it answered, else its loaded question's first line, else the
 *  question an older host kept with a recorded answer (`asked`). */
function replyQuote(
  event: BotItemEvent,
  comments: ReadonlyMap<string, BotItemEvent>,
  pairing: BotItemQuestionPairing
): { eventId: string; text: string; line?: number } | undefined {
  const paired = pairing.replies.get(event.id)
  if (paired) {
    return {
      eventId: paired.questionId,
      text: botItemQuestionFirstLine(paired.decision.question),
      line: paired.line
    }
  }
  const eventId = answeredQuestion(event)
  if (eventId === null) {
    return undefined
  }
  const asked = comments.get(eventId)?.data.text ?? event.data.asked
  const text = typeof asked === 'string' ? botItemQuestionFirstLine(asked) : ''
  return text ? { eventId, text } : undefined
}

function eventEntries(
  item: Pick<BotItem, 'question' | 'status'>,
  events: readonly BotItemEvent[]
): BotItemActivityEntry[] {
  const entries: BotItemActivityEntry[] = []
  const comments = new Map<string, BotItemEvent>()
  for (const event of events) {
    if (event.kind === 'commented') {
      comments.set(event.id, event)
    }
  }
  const pairing = botItemQuestionPairing(item, events)
  const kept = events.filter((event) => !isSnoozeMark(event))
  const place = new Map(kept.map((event, index) => [event, index]))
  const prev = (event: BotItemEvent): BotItemEvent | undefined => {
    const index = place.get(event)
    return index === undefined ? undefined : kept[index - 1]
  }
  for (const event of events) {
    if (event.kind === 'linked' && linksOnlyWorkers(event)) {
      continue
    }
    if (!isSnoozeMark(event) && asksWith(prev(event), event)) {
      continue
    }
    if (event.kind === 'status' && event.data.cause === 'answer') {
      // Its reply is the owner's comment of the same write (an early unsnooze can come between),
      // which quotes the question; with the question on an earlier page the move stays.
      const reply = prev(event)
      if (reply?.at === event.at && comments.has(answeredQuestion(reply) ?? '')) {
        continue
      }
    }
    if (event.kind !== 'commented') {
      entries.push({ kind: 'event', key: event.id, at: event.at, event })
      continue
    }
    const answered = answeredLines(event, pairing)
    // The phone quotes the line it answers; the desktop names each line instead.
    const replyTo = replyQuote(event, comments, pairing)
    const asked = pairing.questions.get(event.id)
    entries.push({
      kind: 'comment',
      key: event.id,
      at: event.at,
      event,
      // A question asked in prose waits while it is the item's question.
      waiting: asked
        ? asked.waiting
        : event.id === item.question?.eventId && event.actor.kind !== 'owner',
      ...(asked ? { answers: asked.answers, byOrder: asked.byOrder } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(answered ? { answered } : {})
    })
  }
  return entries
}

/** `pending`: the owner's comments sent from here that the host's events don't show yet, last as sent;
 *  one the host refused (`refused`, by event id) answers nothing until it is sent again. */
export function botItemActivity(
  item: Pick<BotItem, 'links' | 'question' | 'status'>,
  events: readonly BotItemEvent[],
  pending: readonly BotItemEvent[] = [],
  refused: ReadonlySet<string> = new Set()
): BotItemActivityEntry[] {
  const pairs = pending.filter((event) => !refused.has(event.id))
  const all = pairs.length > 0 ? [...events, ...pairs] : events
  const sent = new Set(pending)
  const listed = eventEntries(item, all)
  const entries = listed.filter((entry) => !('event' in entry) || !sent.has(entry.event))
  for (const link of botItemLinksOnePerChain(item.links)) {
    if (link.kind !== 'dispatch') {
      continue
    }
    if (link.startedAt !== null) {
      entries.push({
        kind: 'worker',
        key: `${link.ref}:started`,
        at: link.startedAt,
        phase: 'started',
        link
      })
    }
    if (link.settledAt !== null) {
      entries.push({
        kind: 'worker',
        key: `${link.ref}:finished`,
        at: link.settledAt,
        phase: 'finished',
        link
      })
    }
  }
  entries.sort((a, b) => a.at - b.at)
  if (pending.length === 0) {
    return entries
  }
  const paired = new Map(
    listed.flatMap((entry) =>
      'event' in entry && sent.has(entry.event) ? [[entry.event, entry]] : []
    )
  )
  return [
    ...entries,
    ...pending.map(
      (event): BotItemActivityEntry =>
        paired.get(event) ?? { kind: 'comment', key: event.id, at: event.at, event, waiting: false }
    )
  ]
}
