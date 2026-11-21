// A comment shows in the item's Activity the moment it is sent, before the host has it: it stays as
// sent until the item's read shows the host's event, and one the host refused stays with Retry. They
// live outside the view, per item, so leaving the item (Back, a step, closing the panel) loses none.
import { useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { botRefKey, botTarget, type BotRef } from '@/lib/bot-hosts'
import { readCachedRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { BOTS_ITEM_COMMENT_REQUEST_ID_RUNTIME_CAPABILITY } from '../../../../../shared/bot-runtime-capabilities'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import {
  botItemCommentImages,
  parseBotItemEventId,
  type BotItemEvent
} from '../../../../../shared/bots/bot-items'
import { botErrorMessage } from '../bot-presentation'
import { commentOnBotItem } from './use-bot-items'

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
  failed: boolean
}

export type BotItemPendingComments = {
  /** Sent comments the item's read doesn't show yet, oldest first. */
  shown: readonly BotItemPendingComment[]
  /** `after`: the id of the item's newest event as the view shows it. */
  send: (text: string, paths: readonly string[], after: string | null) => void
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

function deliver(bot: BotRef, uid: string, key: string, entry: BotItemPendingComment): void {
  const { id } = entry.event
  const queued = (queues.get(key) ?? Promise.resolve())
    .then(() =>
      commentOnBotItem(bot, uid, commentText(entry), entry.paths, entry.requestId ?? undefined)
    )
    .then(
      (result) => {
        const eventId = hostEventId(result)
        // No event: the host had nothing to add, so nothing waits to show.
        update(key, id, eventId ? { eventId, failed: false } : null)
      },
      (error: unknown) => {
        toast.error(botErrorMessage(error))
        update(key, id, { failed: true })
      }
    )
  queues.set(key, queued)
}

/** The sent comments the read shows now, in send order. By the host's event id, or by the request id
 *  the host stored with it; on an older host, a refused one whose call ended after the host stored it
 *  (a timeout) by the owner's next comment after it with the same text and image count, never one
 *  another comment's answer named. A comment's event is the floor
 *  only for comments sent after it: `floors` holds that floor for each one still pending. */
export function botItemPendingCommentsShownByRead(
  entries: readonly BotItemPendingComment[],
  events: readonly BotItemEvent[]
): { done: Set<string>; floors: Map<string, number> } {
  const ids = new Set(events.map((event) => event.id))
  const answered = new Set(entries.flatMap((entry) => (entry.eventId ? [entry.eventId] : [])))
  const done = new Set<string>()
  const floors = new Map<string, number>()
  let floor = 0
  for (const entry of entries) {
    const after = Math.max(entry.after, floor)
    if (entry.eventId) {
      if (ids.has(entry.eventId)) {
        done.add(entry.event.id)
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
              event.data.text === commentText(entry) &&
              botItemCommentImages(event.data).length === entry.paths.length
          )
        : undefined
    if (match) {
      done.add(entry.event.id)
      floor = Math.max(floor, parseBotItemEventId(match.id) ?? 0)
    } else {
      floors.set(entry.event.id, after)
    }
  }
  return { done, floors }
}

export function useBotItemPendingComments(
  bot: BotRef,
  uid: string,
  events: readonly BotItemEvent[]
): BotItemPendingComments {
  const key = `${botRefKey(bot)}\0${uid}`
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
  const { done, floors } = botItemPendingCommentsShownByRead(entries, events)
  // Once the read shows them they are the host's: they leave the store, and comments sent after them
  // keep their floor.
  useEffect(() => {
    if (done.size > 0) {
      write(key, (prev) =>
        prev.flatMap((entry) => {
          if (done.has(entry.event.id)) {
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
    send: (text, paths, after) => {
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
        requestId: takesRequestId(bot) ? createNonSecureContextUuid() : null,
        failed: false
      }
      write(key, (prev) => [...prev, entry])
      deliver(bot, uid, key, entry)
    },
    retry: (id) => {
      const entry = read(key).find((candidate) => candidate.event.id === id)
      if (entry?.failed) {
        update(key, id, { failed: false })
        deliver(bot, uid, key, entry)
      }
    },
    discard: (id) => update(key, id, null)
  }
}

/** An unknown answer is no: an older host refuses the field. This app's own host always takes it. */
function takesRequestId(bot: BotRef): boolean {
  const environmentId = runtimeTargetEnvironmentId(botTarget(bot))
  return (
    environmentId === null ||
    readCachedRuntimeEnvironmentCapability(
      environmentId,
      BOTS_ITEM_COMMENT_REQUEST_ID_RUNTIME_CAPABILITY
    ) === true
  )
}

function commentText(entry: BotItemPendingComment): string {
  return typeof entry.event.data.text === 'string' ? entry.event.data.text : ''
}

function hostEventId(result: unknown): string | null {
  return typeof result === 'object' &&
    result !== null &&
    'eventId' in result &&
    typeof result.eventId === 'string'
    ? result.eventId
    : null
}
