// A bot's chats as the chat composing a message reads them (`bots.chats` as that session, closed ones
// too), shared by the `@` list, the pills and Send's check, so each bot is read once per composer.
// A composing chat's reads live while a composer of it is mounted, and only its composers hear them.
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { botRefKey, callBotRpc, type BotRef } from '@/lib/bot-hosts'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import type { BotChatRow } from '../../../../shared/bots/bot-chat-row'
import { reuseEqualJson } from '../../../../shared/reuse-equal-json'

export type BotMentionChatsRead =
  | { status: 'loading' }
  | { status: 'error' }
  /** Kept while a later read runs, so the list never blanks. */
  | { status: 'ready'; rows: readonly BotChatRow[] }

type Entry = { ref: BotRef; read: BotMentionChatsRead; inFlight: boolean; again: boolean }

/** One composing chat's reads by bot; `snapshot` is replaced on each change its composers show. */
type CallerReads = {
  caller: string | null
  entries: Map<string, Entry>
  snapshot: ReadonlyMap<string, BotMentionChatsRead>
  listeners: Set<() => void>
}

const callers = new Map<string, CallerReads>()
const NO_READS: ReadonlyMap<string, BotMentionChatsRead> = new Map()

const callerKey = (caller: string | null): string => caller ?? ''

function readsOf(caller: string | null): CallerReads {
  let reads = callers.get(callerKey(caller))
  if (!reads) {
    reads = { caller, entries: new Map(), snapshot: NO_READS, listeners: new Set() }
    callers.set(callerKey(caller), reads)
  }
  return reads
}

function changed(reads: CallerReads): void {
  reads.snapshot = new Map([...reads.entries].map(([key, entry]) => [key, entry.read]))
  reads.listeners.forEach((listener) => listener())
}

function settle(reads: CallerReads, entry: Entry, read: BotMentionChatsRead): void {
  const before = entry.read
  const rows = read.status === 'ready' && before.status === 'ready' ? before.rows : null
  // An answer that repeats the last one tells no one.
  if (rows && read.status === 'ready' && reuseEqualJson(rows, read.rows) === rows) {
    return
  }
  entry.read = read
  changed(reads)
}

/** Reads the bot's chats again; a read already running is followed by one more. */
export function requestBotMentionChats(ref: BotRef, caller: string | null): void {
  const reads = readsOf(caller)
  const key = botRefKey(ref)
  let entry = reads.entries.get(key)
  if (!entry) {
    entry = {
      ref: { hostId: ref.hostId, id: ref.id },
      read: { status: 'loading' },
      inFlight: false,
      again: false
    }
    reads.entries.set(key, entry)
    changed(reads)
  } else if (entry.read.status === 'error') {
    settle(reads, entry, { status: 'loading' })
  }
  if (entry.inFlight) {
    entry.again = true
    return
  }
  entry.inFlight = true
  const asked = entry
  void callBotRpc<{ chats: BotChatRow[] }>(asked.ref, 'bots.chats', {
    botId: ref.id,
    ...(caller ? { callerSessionId: caller } : {}),
    all: true
  })
    .then(
      ({ chats }) =>
        live(reads, key, asked) && settle(reads, asked, { status: 'ready', rows: chats }),
      () => live(reads, key, asked) && settle(reads, asked, { status: 'error' })
    )
    .finally(() => {
      asked.inFlight = false
      if (asked.again && live(reads, key, asked)) {
        asked.again = false
        requestBotMentionChats(asked.ref, caller)
      }
    })
}

/** Whether the read is still held: its composers closed drops it, and its answer with it. */
function live(reads: CallerReads, key: string, entry: Entry): boolean {
  return callers.get(callerKey(reads.caller)) === reads && reads.entries.get(key) === entry
}

/** The reads of `caller`'s composers; its last composer unmounting releases them. */
function subscribeTo(caller: string | null, listener: () => void): () => void {
  const reads = readsOf(caller)
  reads.listeners.add(listener)
  return () => {
    reads.listeners.delete(listener)
    if (reads.listeners.size === 0 && callers.get(callerKey(caller)) === reads) {
      callers.delete(callerKey(caller))
    }
  }
}

/** Re-renders on a read of this chat's; `read(ref)` is that bot's latest, null before its first ask. */
export function useBotMentionChatsReads(
  caller: string | null
): (ref: BotRef) => BotMentionChatsRead | null {
  const subscribe = useCallback((listener: () => void) => subscribeTo(caller, listener), [caller])
  const getSnapshot = useCallback(
    () => callers.get(callerKey(caller))?.snapshot ?? NO_READS,
    [caller]
  )
  const reads = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return useCallback((ref: BotRef) => reads.get(botRefKey(ref)) ?? null, [reads])
}

/** Reads each bot in `refs` now and again whenever its chats change on its host. */
export function useBotMentionChatsWatch(refs: readonly BotRef[], caller: string | null): void {
  useEffect(() => {
    refs.forEach((ref) => requestBotMentionChats(ref, caller))
    const stops = refs.map((ref) =>
      onBotsChanged(() => requestBotMentionChats(ref, caller), ref.hostId, {
        botId: ref.id,
        kinds: ['chats']
      })
    )
    return () => stops.forEach((stop) => stop())
  }, [refs, caller])
}
