// An item's Activity in time order: its own events, plus each linked worker's start and finish read
// from the worker's own record (never stored on the item). A worker's link event is its start.
// A Needs you question and its status move come in one write: the comment carries both.
// The owner's reply quotes the question line it answers (bot-item-question-answers.ts); the move the
// first one caused (`cause: 'answer'`) is not shown while the question is loaded. Answers recorded by
// older hosts are replies like any other.
import { botItemCommentFiles } from './bot-item-comment-files'
import { botItemNamedAnswers } from './bot-item-answer-lines'
import {
  botItemCommentImages,
  botItemLinksOnePerChain,
  type BotItem,
  type BotItemEvent,
  type BotItemLinkView
} from './bot-items'
import { botItemQuestionPairing, type BotItemQuestionPairing } from './bot-item-question-answers'

type DispatchLink = Extract<BotItemLinkView, { kind: 'dispatch' }>

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
      /** On the owner's reply to a question: the question it answers, by its first line. */
      replyTo?: { eventId: string; text: string }
      /** The owner's answer reads in full on its ask's lines ("Question → answer"): no card of its own. */
      onAsk?: true
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

/** An answer the ask's lines show whole: words only, no recorded picks, images or files, and where it
 *  names its lines, nothing but those lines. */
function readsOnAsk(event: BotItemEvent, pairing: BotItemQuestionPairing): boolean {
  const text = typeof event.data.text === 'string' ? event.data.text : ''
  const paired = pairing.replies.get(event.id)
  const ask = paired ? pairing.questions.get(paired.questionId) : undefined
  if (!ask) {
    return false
  }
  const { shape } = ask
  // With several questions, a comment that named no line is a comment of its own.
  if (
    shape.decisions.length > 1 &&
    ask.answers.some((answer, index) => answer?.id === event.id && ask.byOrder[index])
  ) {
    return false
  }
  const lines = text.split('\n').filter((line) => line.trim())
  const named = botItemNamedAnswers(shape, text).filter((words) => words !== null).length
  return (
    (named === 0 || named === lines.length) &&
    !Array.isArray(event.data.decisions) &&
    botItemCommentImages(event.data).length === 0 &&
    botItemCommentFiles(text).files.length === 0
  )
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
): { eventId: string; text: string } | undefined {
  const paired = pairing.replies.get(event.id)
  if (paired) {
    return { eventId: paired.questionId, text: botItemQuestionFirstLine(paired.decision.question) }
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
  item: Pick<BotItem, 'question' | 'status' | 'waitingAsk'>,
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
  // An ask waits, read or still on an earlier page.
  const askWaiting =
    [...pairing.questions.values()].some(({ waiting }) => waiting) ||
    (item.waitingAsk !== undefined && !pairing.questions.has(item.waitingAsk))
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
    const replyTo = replyQuote(event, comments, pairing)
    const asked = pairing.questions.get(event.id)
    entries.push({
      kind: 'comment',
      key: event.id,
      at: event.at,
      event,
      // A question asked in prose waits while it is the item's question and no ask waits before it.
      waiting: asked
        ? asked.waiting
        : event.id === item.question?.eventId && event.actor.kind !== 'owner' && !askWaiting,
      ...(asked ? { answers: asked.answers, byOrder: asked.byOrder } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(readsOnAsk(event, pairing) ? { onAsk: true as const } : {})
    })
  }
  return entries
}

export function botItemActivity(
  item: Pick<BotItem, 'links' | 'question' | 'status' | 'waitingAsk'>,
  events: readonly BotItemEvent[]
): BotItemActivityEntry[] {
  const entries = eventEntries(item, events)
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
  return entries.sort((a, b) => a.at - b.at)
}

/** The move a Waiting item's card, last in Activity, stands in for: its latest status event, while
 *  that set Waiting. */
export function botItemWaitEntryKey(
  item: Pick<BotItem, 'status' | 'wait'>,
  entries: readonly BotItemActivityEntry[]
): string | null {
  if (item.status !== 'waiting' || !item.wait) {
    return null
  }
  const last = entries.findLast((entry) => entry.kind === 'event' && entry.event.kind === 'status')
  return last?.kind === 'event' && last.event.data.to === 'waiting' ? last.key : null
}
