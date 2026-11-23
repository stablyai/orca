// One host read about a bot (its Activity, its chats tree, its Items), shared by every surface showing
// that bot: one read at a time per bot, asks during it shared by one more after it.
import { botRefKey, callBotRpc, type BotRef } from '@/lib/bot-hosts'
import { reuseEqualJson } from '../../../../shared/reuse-equal-json'
import type { BotChangeKind, BotChangeScope } from '../../../../shared/bots/bot-change-scope'
import { BotReadMoreFailed } from '../../../../shared/bots/bot-read-more-failed'
import {
  addBotReadAsk,
  botReadLoadAsk,
  type BotHostReadOptions,
  type BotReadAsk
} from './bot-host-read-asks'

type BotReadEntry<T> = {
  bot: BotRef
  value: T | null
  /** The last read failed. */
  failure: 'failed' | null
  listeners: Set<() => void>
  /** Only the latest read lands, so an older one finishing late cannot overwrite it. */
  latest: number
  /** A read is queued (next microtask, or after the minimum gap). */
  scheduled: boolean
  timer: ReturnType<typeof setTimeout> | null
  inFlight: boolean
  /** A read landed since a surface opened the entry: what it shows is no longer only the kept value. */
  landed: boolean
  /** Asked again while a read ran: one more read follows it. */
  again: boolean
  startedAt: number
  /** What the asks since the last read began cover: some parts, or the whole. */
  parts: BotReadAsk
  /** Asks for more (`requestMore`) waiting on the next read, each told the value it lands. */
  more: ((value: T | null) => void)[]
}

/** One host read about a bot (its Activity, its chats tree), shared by every surface showing that bot. */
export type BotHostRead<T> = {
  /** The kinds of change to the bot that can change this read. */
  kinds: readonly BotChangeKind[]
  /** `parts`: only these changed (`BotHostReadOptions`); absent: read whole. */
  request: (bot: BotRef, parts?: readonly string[] | null) => void
  /** More of the value (its next page), read at once in turn with the rest; the value it lands, or
   *  null when that read failed or the last surface closed. */
  requestMore: (bot: BotRef) => Promise<T | null>
  /** The parts a notice can have changed in the bot's value; null: read whole. */
  partsOf: (scope: BotChangeScope | undefined, bot: BotRef) => readonly string[] | null
  subscribe: (bot: BotRef, listener: () => void) => () => void
  snapshot: (key: string) => T | null
  /** Ready once a value landed; until then, loading or why none came. */
  state: (key: string) => BotHostReadState
  /** A value landed, but the latest read of it failed: what's shown is the last good one. */
  refreshFailed: (key: string) => boolean
  /** A read of the bot landed since its surfaces opened it (a kept value alone doesn't count). */
  landed: (key: string) => boolean
}

export type BotHostReadState = 'loading' | 'ready' | 'failed'

/** Bots whose last value a `keepLast` read keeps after their surfaces close. */
const KEPT_BOTS = 20

export function createBotHostRead<T>(
  method: string,
  pick: (result: never) => T,
  failure: string,
  kinds: readonly BotChangeKind[],
  /** The least time between two reads' starts; asks in between share the one after it. */
  minIntervalMs = 0,
  /** Keep each bot's last value after its last surface closes, shown at once when one opens again while it re-reads. */
  keepLast = false,
  options?: BotHostReadOptions<T>
): BotHostRead<T> {
  const entries = new Map<string, BotReadEntry<T>>()
  // One value per bot, replaced by each read that lands.
  const lastValues = new Map<string, T>()

  const entryFor = (bot: BotRef): BotReadEntry<T> => {
    const key = botRefKey(bot)
    let entry = entries.get(key)
    if (!entry) {
      const ref = { hostId: bot.hostId, id: bot.id }
      entry = {
        bot: ref,
        value: lastValues.get(key) ?? null,
        failure: null,
        listeners: new Set(),
        latest: 0,
        scheduled: false,
        timer: null,
        inFlight: false,
        landed: false,
        again: false,
        startedAt: 0,
        parts: null,
        more: []
      }
      entries.set(key, entry)
    }
    return entry
  }

  const read = async (key: string, entry: BotReadEntry<T>): Promise<void> => {
    const current = ++entry.latest
    entry.inFlight = true
    entry.startedAt = Date.now()
    // Parts only onto a good value: after a failed read, what it missed is unknown.
    const previous = entry.value
    const ask = botReadLoadAsk(
      entry.parts,
      entry.more.length > 0,
      Boolean(previous && !entry.failure)
    )
    const waiters = entry.more
    entry.parts = null
    entry.more = []
    let landed: T | null = null
    const live = (): boolean => current === entry.latest && entries.get(key) === entry
    const show = (shown: T): void => {
      if (live() && shown !== entry.value) {
        entry.value = shown
        entry.listeners.forEach((listener) => listener())
      }
    }
    // A read's value: told to its surfaces when it changed (an unchanged answer tells no one).
    const land = (value: T | null): void => {
      const first = !entry.landed
      entry.landed = true
      if (value !== entry.value || entry.failure || first) {
        entry.value = value
        entry.failure = null
        if (keepLast && value) {
          // Newest last, the oldest dropped past the bound: however many bots a session opens or deletes.
          lastValues.delete(key)
          lastValues.set(key, value)
          const oldest = lastValues.size > KEPT_BOTS ? lastValues.keys().next().value : undefined
          if (oldest !== undefined) {
            lastValues.delete(oldest)
          }
        }
        entry.listeners.forEach((listener) => listener())
      }
    }
    try {
      const value = options
        ? await options.load(entry.bot, previous, ask, show, live, () => entry.again)
        : await callBotRpc<never>(entry.bot, method, { botId: entry.bot.id }).then((result) =>
            // A reply no one shows any more is not compared.
            live() ? reuseEqualJson(previous, pick(result)) : previous
          )
      if (live()) {
        land(value)
        landed = value
      }
    } catch (error) {
      console.error(failure, error)
      // What a read with a failed Show more read stands; that ask fails (its caller says so).
      if (error instanceof BotReadMoreFailed && live()) {
        land(error.landed)
      }
      // A failed read of only more fails just that ask (its caller says so); the list stands.
      const onlyMore = (!ask.whole && ask.parts.length === 0) || error instanceof BotReadMoreFailed
      if (
        !onlyMore &&
        current === entry.latest &&
        entries.get(key) === entry &&
        entry.failure !== 'failed'
      ) {
        entry.failure = 'failed'
        entry.listeners.forEach((listener) => listener())
      }
    } finally {
      waiters.forEach((tell) => tell(landed))
      entry.inFlight = false
      if (entry.again && entries.get(key) === entry) {
        entry.again = false
        schedule(key, entry, entry.more.length > 0)
      }
    }
  }

  // Asks from one commit's consumers, and those while a read runs, share one read.
  const request = (bot: BotRef, named?: readonly string[] | null): void => {
    const entry = entryFor(bot)
    entry.parts = addBotReadAsk(entry.parts, options ? named : null, options?.maxParts ?? 0)
    if (entry.parts) {
      schedule(botRefKey(bot), entry)
    }
  }

  const requestMore = (bot: BotRef): Promise<T | null> => {
    const entry = entryFor(bot)
    return new Promise((tell) => {
      entry.more.push(tell)
      schedule(botRefKey(bot), entry, true)
    })
  }

  /** `now`: an owner's ask for more, which waits for no gap. */
  const schedule = (key: string, entry: BotReadEntry<T>, now = false): void => {
    if (entry.inFlight) {
      entry.again = true
      return
    }
    if (entry.scheduled && !(now && entry.timer)) {
      return
    }
    if (entry.timer) {
      clearTimeout(entry.timer)
    }
    entry.scheduled = true
    const start = (): void => {
      entry.scheduled = false
      entry.timer = null
      // The last surface may have closed since the ask.
      if (entries.get(key) === entry) {
        void read(key, entry)
      }
    }
    const wait = now ? 0 : entry.startedAt + minIntervalMs - Date.now()
    if (wait > 0) {
      entry.timer = setTimeout(start, wait)
    } else {
      entry.timer = null
      queueMicrotask(start)
    }
  }

  return {
    kinds,
    request,
    requestMore,
    partsOf: (scope, bot) =>
      options?.partsOf(scope, bot.id, entries.get(botRefKey(bot))?.value ?? null) ?? null,
    subscribe: (bot, listener) => {
      const key = botRefKey(bot)
      const entry = entryFor(bot)
      entry.listeners.add(listener)
      return () => {
        entry.listeners.delete(listener)
        if (entry.listeners.size === 0 && entries.get(key) === entry) {
          // Nothing lands after the last surface closes.
          entry.latest += 1
          if (entry.timer) {
            clearTimeout(entry.timer)
          }
          entry.more.splice(0).forEach((tell) => tell(null))
          entries.delete(key)
        }
      }
    },
    // A surface's first render reads before it subscribes, so the kept value answers until then.
    snapshot: (key) => (entries.has(key) ? entries.get(key)?.value : lastValues.get(key)) ?? null,
    state: (key) => {
      const entry = entries.get(key)
      if (!entry) {
        return lastValues.has(key) ? 'ready' : 'loading'
      }
      return entry.value ? 'ready' : (entry.failure ?? 'loading')
    },
    landed: (key) => entries.get(key)?.landed ?? false,
    refreshFailed: (key) => {
      const entry = entries.get(key)
      return Boolean(entry?.value) && entry?.failure === 'failed'
    }
  }
}
