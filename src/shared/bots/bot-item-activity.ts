// An item's Activity in time order: its own events, plus each linked worker's start and finish read
// from the worker's own record (never stored on the item). A worker's link event is its start.
// A Needs you question and its status move come in one write: the comment carries both.
import type { BotItem, BotItemEvent, BotItemLinkView } from './bot-items'

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

function eventEntries(
  item: Pick<BotItem, 'question'>,
  events: readonly BotItemEvent[]
): BotItemActivityEntry[] {
  const entries: BotItemActivityEntry[] = []
  events.forEach((event, index) => {
    if (event.kind === 'linked' && linksOnlyWorkers(event)) {
      return
    }
    if (asksWith(events[index - 1], event)) {
      return
    }
    if (event.kind !== 'commented') {
      entries.push({ kind: 'event', key: event.id, at: event.at, event })
      return
    }
    const question =
      event.id === item.question?.eventId
        ? 'open'
        : asksWith(event, events[index + 1])
          ? ownerRepliedTo(events, index)
            ? 'answered'
            : 'asked'
          : null
    entries.push({ kind: 'comment', key: event.id, at: event.at, event, question })
  })
  return entries
}

export function botItemActivity(
  item: Pick<BotItem, 'links' | 'question'>,
  events: readonly BotItemEvent[]
): BotItemActivityEntry[] {
  const entries = eventEntries(item, events)
  for (const link of item.links) {
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
