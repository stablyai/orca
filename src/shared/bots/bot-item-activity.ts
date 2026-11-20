// An item's Activity in time order: its own events, plus each linked worker's start and finish read
// from the worker's own record (never stored on the item). A worker's link event is its start.
// A Needs you question and its status move come in one write: the comment carries both.
// The owner's reply names its question (`answers`) and quotes it; the move it caused (`cause: 'answer'`)
// is not shown while the question is loaded. Answers recorded by older hosts are replies like any other.
import {
  botItemLinksOnePerChain,
  type BotItem,
  type BotItemEvent,
  type BotItemLinkView
} from './bot-items'
import { botItemQuestionShape } from './bot-item-ask'

type DispatchLink = Extract<BotItemLinkView, { kind: 'dispatch' }>

export type BotItemActivityEntry =
  | { kind: 'event'; key: string; at: number; event: BotItemEvent }
  | {
      kind: 'comment'
      key: string
      at: number
      event: BotItemEvent
      /** The agent's question the item waits on now: it shows Needs you and its quick replies. */
      waiting: boolean
      /** On a question: the owner's first reply to it, which may be one of its quick replies. */
      answeredBy?: BotItemEvent
      /** On the owner's reply to a question: the question it answers, by its first line. */
      replyTo?: { eventId: string; text: string }
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

/** What a reply quotes: its loaded question's (first) question line or first line, else the question an older host kept with a
 *  recorded answer (`asked`). */
function replyQuote(
  event: BotItemEvent,
  comments: ReadonlyMap<string, BotItemEvent>
): { eventId: string; text: string } | undefined {
  const eventId = answeredQuestion(event)
  if (eventId === null) {
    return undefined
  }
  const question = comments.get(eventId)
  // An ask's reply quotes its question line, not the body above it.
  const asked = question
    ? (botItemQuestionShape(question.data).decisions[0]?.question ?? question.data.text)
    : event.data.asked
  const text = typeof asked === 'string' ? botItemQuestionFirstLine(asked) : ''
  return text ? { eventId, text } : undefined
}

function eventEntries(
  item: Pick<BotItem, 'question'>,
  events: readonly BotItemEvent[]
): BotItemActivityEntry[] {
  const entries: BotItemActivityEntry[] = []
  const comments = new Map<string, BotItemEvent>()
  const replies = new Map<string, BotItemEvent>()
  for (const event of events) {
    if (event.kind === 'commented') {
      comments.set(event.id, event)
    }
    const question = answeredQuestion(event)
    if (question !== null && !replies.has(question)) {
      replies.set(question, event)
    }
  }
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
    const replyTo = replyQuote(event, comments)
    const answeredBy = replies.get(event.id)
    entries.push({
      kind: 'comment',
      key: event.id,
      at: event.at,
      event,
      waiting: event.id === item.question?.eventId && event.actor.kind !== 'owner',
      ...(answeredBy ? { answeredBy } : {}),
      ...(replyTo ? { replyTo } : {})
    })
  }
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
