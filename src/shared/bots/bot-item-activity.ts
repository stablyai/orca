// An item's Activity in time order: its own events, plus each linked worker's start and finish read
// from the worker's own record (never stored on the item). A worker's link event is its start.
// A Needs you question and its status move come in one write: the comment carries both.
// The owner's answer names its question (`answers`), and the move it caused (`cause: 'answer'`) is not
// shown while the question is loaded: the reply quotes it instead. Answers written before that record are still inferred.
import {
  botItemLinksOnePerChain,
  type BotItem,
  type BotItemEvent,
  type BotItemLinkView
} from './bot-items'

type DispatchLink = Extract<BotItemLinkView, { kind: 'dispatch' }>

/** Open: the item's current question. Answered: the owner commented before the bot asked again.
 *  Asked: an earlier question nobody replied to (asked again, or the item moved on). */
export type BotItemQuestionState = 'open' | 'answered' | 'asked'

export type BotItemActivityEntry =
  | { kind: 'event'; key: string; at: number; event: BotItemEvent }
  | {
      kind: 'comment'
      key: string
      at: number
      event: BotItemEvent
      question: BotItemQuestionState | null
      /** On an answered question: the reply that answered it, when the reply recorded it. */
      answer?: { eventId: string; at: number }
      /** On a recorded answer: the question it answers, by its first line. */
      replyTo?: { eventId: string; text: string }
    }
  | { kind: 'worker'; key: string; at: number; phase: 'started' | 'finished'; link: DispatchLink }

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

/** Whether the owner commented after the question at `index`, before the bot asked again. */
function ownerRepliedTo(events: readonly BotItemEvent[], index: number): boolean {
  for (const later of events.slice(index + 2)) {
    if (later.kind === 'commented' && later.actor.kind === 'owner') {
      return true
    }
    if (later.kind === 'status' && later.data.to === 'needs_you') {
      return false
    }
  }
  return false
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

function answeredQuestion(event: BotItemEvent): string | null {
  return event.kind === 'commented' &&
    event.actor.kind === 'owner' &&
    typeof event.data.answers === 'string'
    ? event.data.answers
    : null
}

function eventEntries(
  item: Pick<BotItem, 'question'>,
  events: readonly BotItemEvent[]
): BotItemActivityEntry[] {
  const entries: BotItemActivityEntry[] = []
  const answers = new Map<string, BotItemEvent>()
  const comments = new Map<string, BotItemEvent>()
  for (const event of events) {
    const question = answeredQuestion(event)
    if (question !== null && !answers.has(question)) {
      answers.set(question, event)
    }
    if (event.kind === 'commented') {
      comments.set(event.id, event)
    }
  }
  events.forEach((event, index) => {
    if (event.kind === 'linked' && linksOnlyWorkers(event)) {
      return
    }
    if (asksWith(events[index - 1], event)) {
      return
    }
    if (event.kind === 'status' && event.data.cause === 'answer') {
      // Its answer is the owner's comment of the same write (an early unsnooze can come between);
      // with its question on an earlier page the move stays.
      const answered = events
        .slice(0, index)
        .findLast((earlier) => earlier.kind === 'commented' && earlier.at === event.at)
      if (answered && comments.has(answeredQuestion(answered) ?? '')) {
        return
      }
    }
    if (event.kind !== 'commented') {
      entries.push({ kind: 'event', key: event.id, at: event.at, event })
      return
    }
    const answer = answers.get(event.id)
    const question =
      event.id === item.question?.eventId
        ? 'open'
        : asksWith(event, events[index + 1])
          ? answer !== undefined || ownerRepliedTo(events, index)
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
      ...(question === 'answered' && answer !== undefined
        ? { answer: { eventId: answer.id, at: answer.at } }
        : {}),
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
