// An item's Activity in time order: its own events, plus each linked worker's start and finish read
// from the worker's own record (never stored on the item). A worker's link event is its start.
// A Needs you question and its status move come in one write: the comment carries both.
// The owner's answer names its question (`answers`), and the move it caused (`cause: 'answer'`) is not
// shown while the question is loaded: a reply quotes it instead, and a recorded answer (one carrying its
// `decisions`) is drawn with its question. Answers written before that record are still inferred.
import {
  botItemLinksOnePerChain,
  type BotItem,
  type BotItemEvent,
  type BotItemLinkView
} from './bot-items'

type DispatchLink = Extract<BotItemLinkView, { kind: 'dispatch' }>

/** Open: the item's current question. Answered: a recorded answer names it, or, for a question asked
 *  before hosts recorded answers, the owner commented before the agent asked again. Asked: a question
 *  that closed with no answer (asked again, or the item moved on). */
export type BotItemQuestionState = 'open' | 'answered' | 'asked'

export type BotItemActivityEntry =
  | { kind: 'event'; key: string; at: number; event: BotItemEvent }
  | {
      kind: 'comment'
      key: string
      at: number
      event: BotItemEvent
      question: BotItemQuestionState | null
      /** On an answered question: the reply or recorded answer that answered it. */
      answer?: BotItemEvent
      /** On the owner's reply to a question: the question it answers, by its first line. */
      replyTo?: { eventId: string; text: string }
    }
  /** A recorded answer whose question is not in the loaded page: its own text says what it answered. */
  | { kind: 'answer'; key: string; at: number; event: BotItemEvent }
  | { kind: 'worker'; key: string; at: number; phase: 'started' | 'finished'; link: DispatchLink }

/** The question an owner's comment answers (`answers`): a reply written while the agent asked, or a
 *  recorded answer. Null for any other event. */
function answeredQuestion(event: BotItemEvent): string | null {
  return event.kind === 'commented' &&
    event.actor.kind === 'owner' &&
    typeof event.data.answers === 'string'
    ? event.data.answers
    : null
}

/** The question a recorded answer names, or null for any other event. Only an answer that carries its
 *  decisions is recorded; a plain reply, even one linked to its question, never is. */
export function botItemAnsweredQuestion(event: BotItemEvent): string | null {
  return Array.isArray(event.data.decisions) ? answeredQuestion(event) : null
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

function isAsk(event: BotItemEvent): boolean {
  return event.kind === 'status' && event.data.to === 'needs_you'
}

/** The owner's comment and their move from Needs you to In progress, written together: a reply that
 *  handed the item back. */
function isOwnerReplyMove(comment: BotItemEvent, move: BotItemEvent | undefined): boolean {
  return (
    comment.kind === 'commented' &&
    comment.actor.kind === 'owner' &&
    botItemAnsweredQuestion(comment) === null &&
    move?.kind === 'status' &&
    move.actor.kind === 'owner' &&
    move.data.from === 'needs_you' &&
    move.data.to === 'working' &&
    move.at === comment.at
  )
}

/** The owner's move to In progress written with an answer: the receipt already says it. */
function movedWithAnswer(previous: BotItemEvent | undefined, event: BotItemEvent): boolean {
  return (
    previous !== undefined &&
    botItemAnsweredQuestion(previous) !== null &&
    event.kind === 'status' &&
    event.actor.kind === 'owner' &&
    event.at === previous.at
  )
}

/** What happened from each event up to the next Needs you move (the agent asking again ends a question's
 *  window): whether the owner commented, and whether an owner reply handed the item back. One backward
 *  pass over the events with snooze marks set aside, so it stays linear however many questions. */
function questionWindows(events: readonly BotItemEvent[]): {
  prev: (index: number) => BotItemEvent | undefined
  next: (index: number) => BotItemEvent | undefined
  window: (index: number) => { ownerCommented: boolean; ownerReplied: boolean }
} {
  const kept: number[] = []
  const place = Array.from({ length: events.length }, () => -1)
  for (let index = 0; index < events.length; index += 1) {
    if (!isSnoozeMark(events[index]!)) {
      place[index] = kept.length
      kept.push(index)
    }
  }
  const at = (k: number): BotItemEvent | undefined =>
    k >= 0 && k < kept.length ? events[kept[k]!] : undefined
  // Per kept event: the window that starts right after it.
  const commentedAfter = Array.from({ length: kept.length }, () => false)
  const repliedAfter = Array.from({ length: kept.length }, () => false)
  let commented = false
  let replied = false
  for (let k = kept.length - 1; k >= 0; k -= 1) {
    commentedAfter[k] = commented
    repliedAfter[k] = replied
    const event = at(k)!
    if (isAsk(event)) {
      commented = false
      replied = false
      continue
    }
    if (event.kind === 'commented' && event.actor.kind === 'owner') {
      commented = true
      replied ||= isOwnerReplyMove(event, at(k + 1))
    }
  }
  return {
    prev: (index) => at(place[index]! - 1),
    next: (index) => at(place[index]! + 1),
    // A question's window starts after its own Needs you move when that move is next to it.
    window: (index) => {
      const k = place[index]!
      const from = at(k + 1) && isAsk(at(k + 1)!) ? k + 1 : k
      return { ownerCommented: commentedAfter[from]!, ownerReplied: repliedAfter[from]! }
    }
  }
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

function eventEntries(
  item: Pick<BotItem, 'question'>,
  events: readonly BotItemEvent[]
): BotItemActivityEntry[] {
  const entries: BotItemActivityEntry[] = []
  const loaded = new Set(events.map((event) => event.id))
  const answers = new Map<string, BotItemEvent>()
  const comments = new Map<string, BotItemEvent>()
  for (const event of events) {
    const question = answeredQuestion(event)
    // The first answer is the one that took the question.
    if (question !== null && !answers.has(question)) {
      answers.set(question, event)
    }
    if (event.kind === 'commented') {
      comments.set(event.id, event)
    }
  }
  const { prev, next, window } = questionWindows(events)
  events.forEach((event, index) => {
    if (event.kind === 'linked' && linksOnlyWorkers(event)) {
      return
    }
    if (
      !isSnoozeMark(event) &&
      (asksWith(prev(index), event) || movedWithAnswer(prev(index), event))
    ) {
      return
    }
    const recorded = botItemAnsweredQuestion(event)
    if (recorded !== null) {
      if (!loaded.has(recorded)) {
        entries.push({ kind: 'answer', key: event.id, at: event.at, event })
      }
      return
    }
    if (event.kind === 'status' && event.data.cause === 'answer') {
      // Its answer is the owner's comment of the same write (an early unsnooze can come between);
      // with its question on an earlier page the move stays.
      const reply = prev(index)
      if (reply?.at === event.at && comments.has(answeredQuestion(reply) ?? '')) {
        return
      }
    }
    if (event.kind !== 'commented') {
      entries.push({ kind: 'event', key: event.id, at: event.at, event })
      return
    }
    const answer = answers.get(event.id)
    // A marked question, or one an answer names, is a question whatever its status move carried (a
    // note included): an answer or the owner's reply closed it, else it went unanswered. An unmarked
    // one is known by sitting with its Needs you move, and any owner comment after it counts.
    const question =
      event.id === item.question?.eventId
        ? 'open'
        : event.data.answerable === true || answer
          ? answer || window(index).ownerReplied
            ? 'answered'
            : 'asked'
          : asksWith(event, next(index))
            ? window(index).ownerCommented
              ? 'answered'
              : 'asked'
            : null
    const asked = comments.get(answeredQuestion(event) ?? '')
    const replyTo = asked
      ? { eventId: asked.id, text: botItemQuestionFirstLine(String(asked.data.text ?? '')) }
      : undefined
    entries.push({
      kind: 'comment',
      key: event.id,
      at: event.at,
      event,
      question,
      ...(answer && question === 'answered' ? { answer } : {}),
      ...(replyTo?.text ? { replyTo } : {})
    })
  })
  return entries
}

export function botItemActivity(
  item: Pick<BotItem, 'links' | 'question'>,
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
