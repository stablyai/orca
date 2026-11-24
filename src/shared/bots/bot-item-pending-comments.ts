// A comment shows in the item's Activity the moment it is sent, before the host has it: it stays as
// sent until the item's read shows the host's event, and one the host refused stays with Retry. They
// live outside the view, per item, so leaving the item (Back, a step, closing the panel) loses none.
import type * as React from 'react'
import { createNonSecureContextUuid } from '../identifiers/non-secure-context-uuid'
import {
  botItemCommentImages,
  parseBotItemEventId,
  type BotItemCommentSkill,
  type BotItemEvent
} from './bot-items'
import type { BotItemQuestionShape } from './bot-item-ask'

export type BotItemPendingComment = {
  /** The comment as the host will show it, the owner's; `at` is this machine's send time. */
  event: BotItemEvent
  paths: readonly string[]
  /** The item's newest event when it was sent: the host's copy comes after it. */
  after: number
  /** The host's event once it took the comment. */
  eventId: string | null
  /** The comment's id on a host that dedupes by it: a Retry returns the comment already made, and
   *  the read names it. Null on an older host, where a refused one matches by its text. */
  requestId: string | null
  /** The question a quick reply answers: the host refuses it once the agent has asked another. */
  questionId: string | null
  /** Answers no question the agent waits on: the comment box named none. */
  plain: boolean
  /** Skills picked in it, each by its file on the bot's host; empty where the host takes none. */
  skills?: readonly BotItemCommentSkill[]
  /** With `questionId`, the ask's lines this answer skips; empty where the host takes none. */
  skipped?: readonly number[]
  /** What it answers, as this device composed it: never posted, kept whatever the host takes, so the
   *  ask shows its lines as sent, and they can't be sent twice, whatever the comment's words. */
  intent?: BotItemPendingIntent
  failed: boolean
  /** Failed after it went out, with no request id to dedupe a Retry by: it may be on the host, so it
   *  offers only Discard until the read shows it. */
  mayHaveArrived?: true
}

/** The sent comments the read shows now, in send order. By the host's event id, or by the request id
 *  the host stored with it; on an older host, a refused one whose call ended after the host stored it
 *  (a timeout) by the owner's next comment after it with the same text and image count, never one
 *  another comment's answer named. A comment's event is the floor
 *  only for comments sent after it: `floors` holds that floor for each one still pending. `confirmed`:
 *  those the read names by the host's event or request id, not by their words. */
function botItemPendingCommentsShownByRead(
  entries: readonly BotItemPendingComment[],
  events: readonly BotItemEvent[]
): { done: Set<string>; confirmed: Set<string>; floors: Map<string, number> } {
  const ids = new Set(events.map((event) => event.id))
  const answered = new Set(entries.flatMap((entry) => (entry.eventId ? [entry.eventId] : [])))
  const done = new Set<string>()
  const confirmed = new Set<string>()
  const floors = new Map<string, number>()
  let floor = 0
  for (const entry of entries) {
    const after = Math.max(entry.after, floor)
    if (entry.eventId) {
      if (ids.has(entry.eventId)) {
        done.add(entry.event.id)
        confirmed.add(entry.event.id)
        floor = Math.max(floor, parseBotItemEventId(entry.eventId) ?? 0)
      } else {
        floors.set(entry.event.id, after)
      }
      continue
    }
    // A host that took a request id names it; on an older one only a refused comment is matched by
    // its text: one still in flight is the host's answer to wait for, never a guess.
    const match = entry.requestId
      ? events.find((event) => event.data.requestId === entry.requestId)
      : entry.failed
        ? events.find(
            (event) =>
              !answered.has(event.id) &&
              event.kind === 'commented' &&
              event.actor.kind === 'owner' &&
              (parseBotItemEventId(event.id) ?? 0) > after &&
              event.data.text === botItemPendingCommentText(entry) &&
              botItemCommentImages(event.data).length === entry.paths.length
          )
        : undefined
    if (match) {
      done.add(entry.event.id)
      if (entry.requestId) {
        confirmed.add(entry.event.id)
      }
      floor = Math.max(floor, parseBotItemEventId(match.id) ?? 0)
    } else {
      floors.set(entry.event.id, after)
    }
  }
  return { done, confirmed, floors }
}

export function botItemPendingCommentText(entry: BotItemPendingComment): string {
  return typeof entry.event.data.text === 'string' ? entry.event.data.text : ''
}

/** The ask a comment answers and its answer per question line (null: a line it leaves alone). */
export type BotItemPendingIntent = {
  askId: string
  shape: BotItemQuestionShape
  answers: readonly (string | null)[]
  /** The comment box's original words when the post quotes them to avoid answering another line. */
  rideAlongText?: string
}

/** A post's rejection when the connection dropped after the comment went out. */
export class BotItemCommentMayHaveArrived extends Error {}

/** How an item's pending comments reach its host. */
export type BotItemPendingCommentDelivery = {
  /** Posts the comment: resolves with the host's answer, rejects when it was refused or may not have
   *  arrived. */
  post: (entry: BotItemPendingComment) => Promise<unknown>
  /** Says why a comment wasn't sent; it stays with Retry, unless it answered a question the agent
   *  has since replaced (`replaced`): that one goes, as a Retry would fail the same way. */
  failed: (error: unknown, replaced: boolean) => void
  /** A replaced question's reply, dropped: its words go back to the comment box if it is empty. */
  returnText: (text: string, entry: BotItemPendingComment) => void
  /** Re-reads the item after a replaced question's refusal, so the box names the ask that replaced it
   *  even when the view missed the change. */
  refresh: () => void
  /** The host dedupes comments by request id, so a Retry never posts twice. */
  requestIds: boolean
  /** The host binds a quick reply to its question. */
  questionIds: boolean
  /** The host takes a comment that answers no question while the agent waits on one. */
  plain: boolean
  /** The host takes a comment's picked skills. */
  skills?: boolean
  /** The host takes an answer's skipped lines. */
  skipped?: boolean
  /** The comment is, or may be, on the host: it took it, or one that may have arrived was discarded. */
  delivered?: (entry: BotItemPendingComment) => void
}

export type BotItemPendingComments = {
  /** Sent comments the item's read doesn't show yet, oldest first. */
  shown: readonly BotItemPendingComment[]
  /** `after`: the id of the item's newest event as the view shows it; `questionId`: the ask a quick
   *  reply answers; `plain`: it answers no question; `skills`: the skills picked in it; `skipped`: the
   *  ask's lines it skips. */
  send: (
    text: string,
    paths: readonly string[],
    after: string | null,
    questionId?: string,
    plain?: boolean,
    skills?: readonly BotItemCommentSkill[],
    skipped?: readonly number[],
    intent?: BotItemPendingIntent
  ) => void
  retry: (id: string) => void
  discard: (id: string) => void
}

const NONE: readonly BotItemPendingComment[] = []
const pendingByItem = new Map<string, readonly BotItemPendingComment[]>()
const listeners = new Map<string, Set<() => void>>()
// One queue per item, so its comments reach the host in the order they were sent.
const queues = new Map<string, Promise<void>>()
let sent = 0

function nextPendingId(): string {
  sent += 1
  return `pending:${sent}`
}

function read(key: string): readonly BotItemPendingComment[] {
  return pendingByItem.get(key) ?? NONE
}

function write(
  key: string,
  change: (prev: readonly BotItemPendingComment[]) => readonly BotItemPendingComment[]
): void {
  const prev = read(key)
  const next = change(prev)
  if (next.length === prev.length && next.every((entry, index) => entry === prev[index])) {
    return
  }
  if (next.length === 0) {
    pendingByItem.delete(key)
  } else {
    pendingByItem.set(key, next)
  }
  listeners.get(key)?.forEach((listener) => listener())
}

function update(key: string, id: string, change: Partial<BotItemPendingComment> | null): void {
  write(key, (prev) =>
    change === null
      ? prev.filter((entry) => entry.event.id !== id)
      : prev.map((entry) => (entry.event.id === id ? { ...entry, ...change } : entry))
  )
}

function hostCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

function deliver(
  key: string,
  entry: BotItemPendingComment,
  delivery: BotItemPendingCommentDelivery
): void {
  const { id } = entry.event
  const queued = (queues.get(key) ?? Promise.resolve())
    .then(() => delivery.post(entry))
    .then(
      (result) => {
        const eventId = hostEventId(result)
        delivery.delivered?.(entry)
        // No event: the host had nothing to add, so nothing waits to show.
        update(key, id, eventId ? { eventId, failed: false } : null)
      },
      (error: unknown) => {
        const replaced = entry.questionId !== null && hostCode(error) === 'item_changed'
        delivery.failed(error, replaced)
        if (replaced) {
          update(key, id, null)
          delivery.returnText(botItemPendingCommentText(entry), entry)
          delivery.refresh()
          return
        }
        update(key, id, {
          failed: true,
          ...(error instanceof BotItemCommentMayHaveArrived && !entry.requestId
            ? { mayHaveArrived: true as const }
            : {})
        })
      }
    )
  queues.set(key, queued)
}

/** The hook takes each app's own React, as the phone's bundle resolves `react` apart from this file's. */
export function createBotItemPendingCommentsHook({
  useEffect,
  useSyncExternalStore
}: Pick<typeof React, 'useEffect' | 'useSyncExternalStore'>) {
  /** `key`: one item on one host. */
  return function useBotItemPendingComments(
    key: string,
    events: readonly BotItemEvent[],
    delivery: BotItemPendingCommentDelivery
  ): BotItemPendingComments {
    const entries = useSyncExternalStore(
      (listener) => {
        const set = listeners.get(key) ?? new Set()
        set.add(listener)
        listeners.set(key, set)
        return () => {
          set.delete(listener)
          if (set.size === 0) {
            listeners.delete(key)
          }
        }
      },
      () => read(key)
    )
    const { done, confirmed, floors } = botItemPendingCommentsShownByRead(entries, events)
    // Once the read shows them they are the host's: they leave the store, and comments sent after them
    // keep their floor.
    useEffect(() => {
      if (done.size > 0) {
        write(key, (prev) =>
          prev.flatMap((entry) => {
            if (done.has(entry.event.id)) {
              // The read names it, as when the post returned (its answer may have been lost): the
              // same cleanup, which takes only answers still as sent. A match by its words alone
              // (an older host) isn't proof enough to drop picks that may be unsent.
              if (confirmed.has(entry.event.id)) {
                delivery.delivered?.(entry)
              }
              return []
            }
            const after = floors.get(entry.event.id) ?? entry.after
            return [after > entry.after ? { ...entry, after } : entry]
          })
        )
      }
    })

    return {
      shown: done.size > 0 ? entries.filter((entry) => !done.has(entry.event.id)) : entries,
      send: (text, paths, after, questionId, plain = false, skills = [], skipped = [], intent) => {
        const entry: BotItemPendingComment = {
          event: {
            id: nextPendingId(),
            kind: 'commented',
            actor: { kind: 'owner' },
            data: {
              text,
              images: paths.map((path) => ({
                path,
                name: path.split(/[\\/]/).pop() ?? path,
                bytes: 0
              }))
            },
            at: Date.now()
          },
          paths,
          after: after ? (parseBotItemEventId(after) ?? 0) : 0,
          eventId: null,
          requestId: delivery.requestIds ? createNonSecureContextUuid() : null,
          questionId: questionId && delivery.questionIds ? questionId : null,
          plain: plain && delivery.plain,
          ...(delivery.skills && skills.length > 0 ? { skills } : {}),
          // Only with the ask it answers named: skipped lines are that ask's.
          ...(delivery.skipped && delivery.questionIds && questionId && skipped.length > 0
            ? { skipped }
            : {}),
          ...(intent ? { intent } : {}),
          failed: false
        }
        write(key, (prev) => [...prev, entry])
        deliver(key, entry, delivery)
      },
      retry: (id) => {
        const entry = read(key).find((candidate) => candidate.event.id === id)
        if (entry?.failed && !entry.mayHaveArrived) {
          update(key, id, { failed: false })
          deliver(key, entry, delivery)
        }
      },
      discard: (id) => {
        const entry = read(key).find((candidate) => candidate.event.id === id)
        // It may be on the host: what it answered isn't offered to send again.
        if (entry?.mayHaveArrived) {
          delivery.delivered?.(entry)
        }
        update(key, id, null)
      }
    }
  }
}

function hostEventId(result: unknown): string | null {
  return typeof result === 'object' &&
    result !== null &&
    'eventId' in result &&
    typeof result.eventId === 'string'
    ? result.eventId
    : null
}
